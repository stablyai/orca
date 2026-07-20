# Source Control AI Auto CLI Args

## Status

Reviewed implementation proposal for a product-forward change to Source Control AI text-generation defaults.

This document separates phase-one implementation blockers from future hardening. If code cannot satisfy the phase-one runtime, save-state, host, and all-agent compatibility rules below, the implementation should stop and update the design rather than shipping a partial Auto mode.

## Problem

Source Control AI recipes are flexible because they store CLI arguments as raw text. That flexibility is valuable and should stay. The current default path is still too opaque:

- New users usually leave action recipes untouched.
- Untouched text-generation recipes currently resolve to the selected agent's built-in default model.
- For agents such as Codex, that can mean a frontier/default model for small source-control text tasks like commit messages and hosted-review summaries.
- The UI hints cheaper/faster args in placeholders, but placeholders do not affect execution and are easy to miss.

The product goal is to make the untouched default path fast and economical while keeping the recipe model flexible: users customize CLI args, not a model-selection schema.

## Product Decision

For text-generation Source Control AI actions, `agentArgsMode: 'auto'` means **Auto CLI args**.

Auto is a visible mode in the UI. It is not an empty input. It means:

> Orca chooses recommended fast CLI arguments for the resolved agent and this source-control text action.

The persisted recipe remains raw-CLI-args based, but the mode is explicit:

```ts
// Text-generation actions only: commitMessage, pullRequest, branchName.
{ agentId: null, agentArgsMode: 'auto', agentArgs: '' } // Use default agent + Orca recommended CLI args.
{ agentId: null, agentArgsMode: 'none', agentArgs: '' } // Use default agent + no extra action-level CLI args.
{ agentId: 'codex', agentArgsMode: 'custom', agentArgs: '--...' } // Pinned agent + exact user-authored CLI args.
```

These examples intentionally include `agentId` intent. Saving mode fields must not accidentally omit the action's agent intent: omitted `agentId` can inherit the legacy/global Source Control AI agent, while explicit `agentId: null` means "Use default agent."

For launch/fix actions, Auto does not exist:

```ts
// Launch actions: fixCommitFailure, fixChecks, resolveConflicts, resolveComments.
// agentArgsMode is not used.
{} // No extra CLI args.
{ agentArgs: '' } // No extra CLI args.
{ agentArgs: '--...' } // Custom user-authored CLI args.
```

This intentionally improves untouched recipes for existing and new users. Existing text-generation recipes with no `agentArgsMode` and missing `agentArgs` read as Auto only as a guarded legacy compatibility rule: if the legacy recipe also has a persisted model or thinking choice that Auto would ignore, read it as **None** instead and preserve the existing model-resolution path. New text-action writes must persist `agentArgsMode`. Users who want the old no-extra-action-args behavior can select **None**, which persists `agentArgsMode: 'none'`.

## Goals

- Add only one explicit persisted CLI-args mode field; keep model selection out of the recipe schema.
- Make the default text-generation path faster and cheaper where the selected agent supports that.
- Make Auto explicit in UI and storage so missing legacy args do not feel magical.
- Keep custom CLI args fully flexible for power users.
- Prevent stale custom text-generation args from following a changed default agent.
- Preserve the user's recipe agent intent, especially "Use default agent", when generating once and when saving defaults.
- Keep fix/check/conflict launch actions on the default agent with no recommended fast-model mapping.
- Preserve SSH and remote-runtime behavior by resolving recommendations for the host where the action will run.
- Preserve the existing distinction between non-interactive text-generation agents and launch-capable TUI agents.
- Make unsupported default-agent states recoverable instead of silently running the wrong agent.

## Non-Goals

- Do not add a persisted model-choice schema for action recipes.
- Do not require users to configure each action before first use.
- Do not change prompt wording, diff collection, hosted-review creation, or git-provider behavior.
- Do not apply cheaper/faster model mapping to fix/check/conflict launch actions.
- Do not remove "Use default agent" from action recipes.
- Do not make every TUI agent a text-generation provider. An agent supports these text actions only after it has a non-interactive `CommitMessageAgentSpec`.
- Do not infer model semantics for unknown custom commands.

## Current State

Relevant current defaults:

- `getDefaultSourceControlAiSettings()` creates every action with `{ commandInputTemplate: '{basePrompt}' }` and no `agentArgs`.
- Text-generation resolution uses the recipe agent, then `sourceControlAi.agentId`, then `settings.defaultTuiAgent`. The hard fallback commit-message agent only applies when there is no usable default; an enabled but unsupported default currently surfaces an unsupported-agent error.
- `SourceControlActionRecipeRow` exposes `CLI arguments` as a raw input for all actions.
- `getSourceControlAgentArgsPlaceholder()` already hints values such as `--model gpt-5.4-mini` for Codex and Copilot, but placeholders are not execution behavior.
- `SourceControlTextGenerationDialogForm` also exposes raw `CLI arguments` when generating one-off text.
- Current renderer form state often initializes missing `agentArgs` as `''`. That is fine today, but it would erase the new Auto/None distinction unless the implementation uses explicit mode state.
- The one-off text-generation dialog receives resolved params for planning. Saving defaults from that dialog must not blindly persist the resolved concrete agent when the underlying recipe was "Use default agent."
- Text-generation planning currently appends `agentArgs` after built-in model args. That is correct for Custom mode, but Auto must not use that path when the recommendation is another model flag.
- Repository action overrides have an action-level inherit/customize switch today. Current resolution overlays repo fields on top of global action recipes, so an existing repo override with omitted `agentArgs` can inherit global args. New customized text-action rows should own their `agentArgsMode`, but legacy customized rows with no CLI fields must keep the old inheritance behavior until the user saves an explicit mode.
- Current save, comparison, and preview helpers trim or collapse args in several places. Text-action code that participates in Auto/None/Custom must become mode-aware instead of deriving product state from `agentArgs` truthiness.
- `setSourceControlActionDefault(...)` shallow-merges action recipes. It must not be used for text-action mode saves unless it gains explicit delete/replace semantics for `agentArgsMode` and stale `agentArgs`.
- `completeRepoActionRecipe(...)`, `normalizeCompleteRecipe(...)`, `sourceControlActionRecipeMatchesTarget(...)`, and dialog draft initialization currently treat missing args and empty args as the same state in at least one path. Those paths must become `agentArgsMode`-aware before Auto ships.
- `planSourceControlTextGeneration(...)` currently builds its display command with `[binary, ...args].join(' ')`. That is good enough for a smoke label today, but it is not acceptable as the planned argv preview for Auto because it misrepresents quoted args, Windows/PowerShell escaping, command overrides, and model names with spaces.

## Support Boundary

Source Control AI has two different agent surfaces:

- **Text-generation actions** (`commitMessage`, `pullRequest`, `branchName`) run non-interactive commands through `COMMIT_MESSAGE_AGENT_SPECS`. Auto applies only here.
- **Launch actions** (`fixCommitFailure`, `fixChecks`, `resolveConflicts`, `resolveComments`) start TUI agents in a terminal. Auto does not apply here.

Some agents are in both worlds. For example Claude, Codex, OpenCode, Pi, Amp, Cursor, Kimi, Copilot, and Antigravity can be launched as terminal agents and also have non-interactive text-generation specs. Auto applies only when those agents are invoked through the text-generation path. It must never change their terminal launch behavior, default TUI args, prompt delivery mode, trust preflight, or `TUI_AGENT_CONFIG` startup command.

Keep the support boundary derived from code, not hand-maintained UI lists:

- Text-generation support = `COMMIT_MESSAGE_AGENT_SPECS` plus `custom`.
- Launch support = `TuiAgent`/`TUI_AGENT_CONFIG`.
- Launch-only support = launch support minus text-generation support.

Do not encode launch-only agent names in UI copy or tests. Tests should fail when the text-generation registry changes without updating the recommendation table. Launch registry changes should be covered by registry-derived launch non-regression tests, not by adding launch-only agents to text-generation recommendations.

Implementation must derive user-facing picker options from the same source:

- Text action picker = `listCommitMessageAgentCapabilities()` plus `custom`, while still showing an already-saved unsupported agent as a recoverable invalid state.
- Launch action picker = `getAgentCatalog()`/`TUI_AGENT_CONFIG`, filtered only by existing enabled/detected host state.
- Recommendation registry = every `COMMIT_MESSAGE_AGENT_SPECS` key plus `custom`, crossed with every `SOURCE_CONTROL_TEXT_ACTION_IDS` key.
- Launch non-regression tests = every `TuiAgent` key in `TUI_AGENT_CONFIG`, including agents that are also text-generation-capable.

All launch-only `TuiAgent` values remain valid for launch actions, but they must not appear as selectable text-generation agents until a `CommitMessageAgentSpec` is added and tested. If "Use default agent" resolves to an unsupported text-generation agent, show an inline error and link the user back to the agent picker. Build the supported-agent clause from `listCommitMessageAgentCapabilities()` plus `custom`; do not hard-code the list in UI copy:

> The default agent cannot run Source Control AI text generation. Choose a supported text-generation agent: {supported agent labels}, or Custom command.

For `custom`, Auto resolves to no additional CLI args because Orca cannot know the command's model flag. The UI may still show Auto for consistency, but its preview must be explicit:

> Auto for Custom command: no extra CLI args

## Data Model

No persisted model-choice field is required for the core design. The saved recipe adds one small mode field so Auto/None/Custom are explicit instead of encoded through missing string fields.

Important distinction: persisted recipes stay CLI-args-mode based, but Auto is compiled at runtime as a structured recommendation plan. That plan may set `model`, `thinkingLevel`, and append-only args before the agent spec builds argv. This is not a persisted model-choice schema; it is the runtime implementation of "Orca recommended CLI args."

Keep four data shapes separate:

- **Persisted recipes** are sparse user intent: selected agent intent, command template, `agentArgsMode`, and raw custom args. They are the only shape written to settings.
- **Repo override patches** may use `null` only as a patch/delete or rollback-compatible input signal. Normalized persisted rows should use explicit mode fields instead of relying on null.
- **Complete/effective recipes** are read-time products. They may fill defaults for execution and comparison, but they must not be serialized during unrelated saves.
- **Invocation plans** are host-scoped runtime products. They may contain model ids, thinking levels, argv, and preview data, but they are never copied back into the persisted recipe as model choices.

The action recipe keeps the existing raw CLI-args field and adds one text-action-only mode field. Type boundaries should be action-aware so launch-action writes cannot accidentally carry `agentArgsMode`:

```ts
type TextGenerationCliArgsMode = 'auto' | 'none' | 'custom'

type SourceControlTextRecipeAgentId = TuiAgent | CustomAgentId | null
type SourceControlLaunchRecipeAgentId = TuiAgent | null

type SourceControlTextActionRecipe = {
  agentId?: SourceControlTextRecipeAgentId
  commandInputTemplate?: string
  agentArgsMode?: TextGenerationCliArgsMode
  agentArgs?: string
}

type SourceControlLaunchActionRecipe = {
  agentId?: SourceControlLaunchRecipeAgentId
  commandInputTemplate?: string
  agentArgs?: string
  // Launch actions must not compile if a caller tries to write text-only mode.
  agentArgsMode?: never
}

type SourceControlActionRecipeById = {
  [K in SourceControlTextActionId]: SourceControlTextActionRecipe
} & {
  [K in SourceControlLaunchActionId]: SourceControlLaunchActionRecipe
}

type SourceControlActionRecipe =
  | SourceControlTextActionRecipe
  | SourceControlLaunchActionRecipe
```

Every new persisted action-recipe shape must carry the field for text actions. That means updating:

```ts
type RepoSourceControlAiActionOverrides = Partial<
  {
    [K in SourceControlTextActionId]: {
      agentId?: SourceControlTextRecipeAgentId
      commandInputTemplate?: string | null
      agentArgsMode?: TextGenerationCliArgsMode | null
      agentArgs?: string | null
    }
  } & {
    [K in SourceControlLaunchActionId]: {
      agentId?: SourceControlLaunchRecipeAgentId
      commandInputTemplate?: string | null
      agentArgs?: string | null
      agentArgsMode?: never
    }
  }
>

type RepoSourceControlAiOverrides = {
  actionOverrides?: RepoSourceControlAiActionOverrides
}

type CompleteSourceControlTextActionRecipe = {
  agentId: SourceControlTextRecipeAgentId
  commandInputTemplate: string
  agentArgsMode: TextGenerationCliArgsMode
  agentArgs?: string
}

type CompleteSourceControlLaunchActionRecipe = {
  agentId: SourceControlLaunchRecipeAgentId
  commandInputTemplate: string
  agentArgs?: string
  agentArgsMode?: never
}

type CompleteSourceControlActionRecipeById = {
  [K in SourceControlTextActionId]: CompleteSourceControlTextActionRecipe
} & {
  [K in SourceControlLaunchActionId]: CompleteSourceControlLaunchActionRecipe
}

type CompleteSourceControlActionRecipe =
  | CompleteSourceControlTextActionRecipe
  | CompleteSourceControlLaunchActionRecipe
```

This is not renderer-only metadata. `normalizeSourceControlActionRecipe(...)`, `normalizeRepoSourceControlAiOverrides(...)`, `normalizeWritableRepoSourceControlAiOverrides(...)`, `toSourceControlAiRepoUpdate(...)`, runtime RPC schemas, and save helpers must preserve valid `agentArgsMode` values for text actions. Invalid mode strings should be ignored and interpreted through the legacy fallback below. Launch-action normalizers should drop `agentArgsMode` so the field cannot leak into fix/check/conflict recipes.

Do not rely only on runtime dropping for this safety. Phase one should add mode-aware text-action write helpers, and any generic write helper that remains public must sanitize with the action id before persistence. A full replacement of every generic action type is not required if the persisted boundaries are covered by runtime validation and focused type tests.

Recommended text-action save input:

```ts
type SaveSourceControlTextActionRecipeInput<K extends SourceControlTextActionId> = {
  actionId: K
  recipe: SourceControlActionRecipeById[K]
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  customAgentCommand?: string
}
```

Renderer draft code, repo update builders, runtime/preload schema updates, and tests should preserve text-action mode fields explicitly. Launch writes may keep the existing simple args shape, but they must drop `agentArgsMode` at normalization and schema boundaries.

### Defaults And Normalization Boundaries

Fresh settings creation, legacy read normalization, and writable normalization are three different operations. They must not share a helper that materializes explicit Auto by default.

Required split:

- `createFreshSourceControlAiSettings(...)`: used only for a new profile, first-run settings object, or an explicit "reset to current product defaults" action. It persists explicit text-action Auto defaults:
  ```ts
  {
    commitMessage: { agentId: null, commandInputTemplate: '{basePrompt}', agentArgsMode: 'auto', agentArgs: '' },
    pullRequest: { agentId: null, commandInputTemplate: '{basePrompt}', agentArgsMode: 'auto', agentArgs: '' },
    branchName: { agentId: null, commandInputTemplate: '{basePrompt}', agentArgsMode: 'auto', agentArgs: '' }
  }
  ```
- `normalizeSourceControlAiSettingsForRead(...)`: used when loading or resolving existing settings. It supplies runtime fallback values for missing fields but preserves the distinction between missing legacy fields and explicit saved fields. It must not write `agentArgsMode` into legacy recipes merely because a field is absent.
- `normalizeSourceControlAiSettingsForWrite(...)`: used immediately before persistence. It preserves explicit `agentArgsMode` values and the Auto/None `agentArgs: ''` sentinel when they are present in the write payload. It must not infer Auto for omitted legacy text-action fields unless the caller is `createFreshSourceControlAiSettings(...)` or an explicit user save of that action row.
- `normalizeWritableRepoSourceControlAiOverrides(...)`: same rule for repo overrides. It may upgrade rollback-compatible `agentArgs: null` to explicit None, but it must preserve legacy customized rows that omitted both `agentArgsMode` and `agentArgs` unless the user is saving that action row.

If `getDefaultSourceControlAiSettings(...)` remains in the codebase, pick one role and encode it in the name. Do not keep using a single "default settings" function as both the read-normalization base and the fresh-persisted settings creator. A normalizer that starts from fresh persisted defaults will eagerly migrate old settings during unrelated saves.

Patch-based settings writes need the same separation. Functional `SourceControlAiSettingsPatch` updaters may receive read-normalized settings for convenience, but persistence must write only explicit patch fields plus any action recipe the user actually saved. An unrelated settings save must not serialize inferred text-action Auto into old recipes.

Phase one does not add model-discovery provenance or dynamic fallback. Auto uses a static recommendation table keyed by resolved text-generation agent and source-control text action. If the recommended model or mode is unavailable for a user's account or host, the existing CLI failure path reports the problem. This keeps the implementation small and avoids persisting host-scoped model lists, command fingerprints, sanitized probe errors, or fallback snapshots.

Future work may add a host-scoped discovery-provenance snapshot if product evidence shows that dynamic unavailable-model fallback is worth the extra schema. Until that exists, discovered model caches remain advisory UI data only and must not decide Auto fallback.

The normalizer that decides whether to preserve or drop `agentArgsMode` must know the action id. Today `normalizeSourceControlActionRecipe(...)` is generic; this change requires an action-aware wrapper or replacement such as:

```ts
function normalizeSourceControlActionRecipeForAction<K extends SourceControlActionId>(
  actionId: K,
  value: unknown
): SourceControlActionRecipeById[K] | undefined
```

Generic recipe normalization may still sanitize shared fields, but it must not be the final authority for text-action mode preservation or launch-action mode removal.

`agentArgsMode` is the source of truth for text-generation actions when present:

```ts
// Text-generation writes.
{ agentId: null, agentArgsMode: 'auto', agentArgs: '' } // Auto; clear stale non-empty agentArgs.
{ agentId: null, agentArgsMode: 'none', agentArgs: '' } // None; no extra action-level args.
{ agentId: 'codex', agentArgsMode: 'custom', agentArgs: '--model gpt-5.4-mini' } // Custom.
{ agentId: 'custom', agentArgsMode: 'custom', agentArgs: '--json' } // Custom command + exact extra args.
```

For `agentArgsMode: 'auto'`, new writes must include `agentArgs: ''` as a rollback-safe sentinel and must remove any stale non-empty `agentArgs`. New readers should ignore `agentArgs` when `agentArgsMode` is `auto`. This makes a partially rolled-back or mode-stripping build degrade to no extra args instead of inheriting global custom args or replaying stale Custom flags.

For `agentArgsMode: 'none'`, new writes must include `agentArgs: ''` as a rollback-safe sentinel. New readers must still treat the mode as authoritative even if `agentArgs` is absent.

For `agentArgsMode: 'custom'`, `agentArgs` must contain non-whitespace text before saving. Blank custom args are invalid; users should pick None instead. Custom mode requires a stable concrete execution target before saving: a pinned text-generation agent or `agentId: 'custom'` with a non-empty custom command. It must not save with `agentId: null` because those args would follow whichever default agent is active later.

The examples above show the default-agent case explicitly. If the user has pinned an agent, preserve that concrete `agentId`; if the recipe follows the default agent, persist `agentId: null`. Do not use a mode-only shallow write that leaves agent intent to whatever fallback happens to run later.

Launch actions never use `agentArgsMode`:

```ts
// Launch/fix actions.
{} // No extra CLI args.
{ agentArgs: '' } // No extra CLI args.
{ agentArgs: '--...' } // Custom user-authored CLI args.
```

Any settings row or dialog that lets the user edit text-generation CLI args should store the same explicit mode while editing:

```ts
type TextGenerationRecipeAgentSelection = TuiAgent | CustomAgentId | null

type TextGenerationCliArgsDraft = {
  mode: TextGenerationCliArgsMode
  customAgentArgs: string
}

type TextGenerationRecipeDraft = {
  agentId: TextGenerationRecipeAgentSelection
  commandInputTemplate: string
  cliArgs: TextGenerationCliArgsDraft
}
```

Serialize the draft into the explicit persisted shape at the last boundary:

```ts
function textCliArgsFieldsFromDraft(
  draft: TextGenerationCliArgsDraft
): Pick<SourceControlActionRecipe, 'agentArgsMode' | 'agentArgs'> {
  if (draft.mode === 'auto') {
    return { agentArgsMode: 'auto', agentArgs: '' }
  }
  if (draft.mode === 'none') {
    return { agentArgsMode: 'none', agentArgs: '' }
  }
  return { agentArgsMode: 'custom', agentArgs: draft.customAgentArgs }
}
```

This rule is mandatory because `agentArgs ?? ''` destroys the legacy Auto/None distinction. Controlled inputs may still render `customAgentArgs` as a string, but the selected mode is the source of truth.

Save boundaries must also preserve replacement semantics. Saving Auto is not a shallow merge of `{ agentArgsMode: 'auto' }` into an existing recipe; it must replace the action recipe or explicitly clear stale `agentArgs` to the empty rollback sentinel. Otherwise a Custom -> Auto save can leave misleading custom args for rollback builds, raw settings inspection, or any caller that has not been updated yet. Any helper that updates `actions[actionId]` must have a replace/delete path for text-action CLI fields, not only a shallow merge path.

### Text-Action Write Boundaries

Every code path that creates, normalizes, compares, saves, or transports a text-action recipe must be mode-aware. Do not implement Auto only in the visible settings row and dialog.

Known write and transport boundaries that must be updated or replaced:

- Fresh Source Control AI settings creation must use `createFreshSourceControlAiSettings(...)` (or the final equivalent) and include explicit Auto defaults for text actions. Legacy reads must use `normalizeSourceControlAiSettingsForRead(...)` and must not materialize explicit Auto in the saved object. Writable persistence must use `normalizeSourceControlAiSettingsForWrite(...)` and must not serialize read-inferred defaults during unrelated saves.
- `sourceControlAiSettingsFromLegacy(...)` and `mergeLegacyCommitMessageAiIntoSourceControlAi(...)`: legacy import must not accidentally fill `agentArgs: ''` before mode derivation.
- `setSourceControlActionDefault(...)`: either become an internal read-only/convenience helper with no persistence role, or be replaced by action-discriminated save helpers with replace/delete semantics for text actions.
- `saveSourceControlActionRecipe(...)`, `normalizeCompleteRecipe(...)`, `normalizeWritableRepoSourceControlAiOverrides(...)`, and `toSourceControlAiRepoUpdate(...)`: preserve text-action `agentArgsMode`, preserve `agentArgs: ''` for Auto and None, and never preserve stale non-empty `agentArgs` for Auto.
- Generic `SourceControlAiSettingsPatch` writes that include `actions` must be split into text-action and launch-action patch helpers, or validated at the patch boundary with the action id. A patch write that can persist `actions[actionId]` without knowing whether `actionId` is text or launch is not acceptable for this feature.
- Settings action recipe draft state: store `mode` separately from `customAgentArgs`; do not serialize only `{ commandInputTemplate, agentArgs }`.
- Repository Source Control AI draft state: preserve legacy inherited CLI args, and persist explicit Auto/None/Custom on new saves.
- `SourceControlTextGenerationDialogForm(...)`, `SourceControlTextGenerationDefaults(...)`, `source-control-ai-recipe-persistence.ts`, and `generationParamsToActionRecipe(...)`: save recipe intent and mode, not only resolved execution params.
- `AutoRenameBranchFromWorkSetting(...)`: when it writes the `branchName` text action, preserve or add `agentArgsMode` rather than creating a new text-action recipe with no mode.
- `first-work-branch-rename.ts`: headless `branchName` generation for repo branch rename and folder-title rename must compile Auto at the main/SSH execution boundary, not through renderer dialog state.
- `sourceControlActionRecipeMatchesTarget(...)` and `sourceControlTextGenerationDefaultsMatchTarget(...)`: compare text-action mode first; use legacy `agentArgs` fallback only when mode is absent.
- Runtime and preload transport schemas: preserve `agentArgsMode` anywhere `SourceControlAiSettings` or repo overrides cross IPC/RPC.

Add a regression test that discovers all text-action write helpers, or at minimum covers every path above. A text-action save that omits `agentArgsMode` must fail unless it is explicitly exercising legacy read compatibility. Add a separate regression test proving unrelated global and repo settings saves do not write explicit Auto into legacy text-action recipes.

Legacy reads need a fallback because older saved recipes do not have `agentArgsMode`. This fallback applies to global text recipes and explicit repo CLI fields. Customized repo overrides with no `agentArgsMode` and no `agentArgs` key use the `legacy-inherit-cli-args` rule below instead of calling this fallback directly.

The missing-args legacy fallback must be guarded by model-configuration detection. Auto intentionally overrides model and thinking choices when the user explicitly picks Auto. Legacy data did not explicitly pick Auto, so Orca must not silently bypass a model choice that already exists. If the resolved legacy recipe has any model or thinking configuration that would have been honored by the current resolver for the same text action, resolved agent, host key, and repo/global scope, treat the missing-args legacy recipe as None and show compatibility copy such as:

> Preserving your configured model for this legacy recipe. Choose Auto to use Orca recommended CLI args.

Model-configuration detection includes any value that can affect `selectPersistedModelId(...)` or `resolveThinkingLevel(...)` for that invocation: repo operation overrides, global operation overrides, default selected models, host-scoped selected models, legacy commit-message selections, and selected thinking levels for the selected model. Discovery caches alone are not model configuration.

Do not compute this guard in the renderer from partial form state. The guard belongs next to the text-generation resolver because it needs the same action id, resolved agent, host key, repo/global target, repo overrides, normalized global settings, legacy commit-message settings, and selected-model precedence as execution:

```ts
type LegacyModelConfigurationContext = {
  actionId: SourceControlTextActionId
  resolvedAgentId: TuiAgent | CustomAgentId | null
  hostKey: string
  sourceControlAi: SourceControlAiSettings
  legacyCommitMessageAi?: CommitMessageAiSettings | null
  repoOverrides?: RepoSourceControlAiOverrides | null
  recipeSource: SourceControlAiWriteTarget | 'effective'
}

function hasLegacyModelConfigurationForTextAction(
  context: LegacyModelConfigurationContext
): boolean
```

This helper should call or share the same pure selectors used by execution, not duplicate a looser "any selected model exists" check. It returns true only when the current invocation would have honored a selected model or thinking setting for the resolved text action and agent. A model choice for another action, another host, another agent, or an overridden repo scope that is not effective for this invocation must not block legacy Auto.

```ts
function hasAgentArgsKey(recipe: { agentArgs?: string | null } | null | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(recipe ?? {}, 'agentArgs')
}

function textModeFromRecipe(
  recipe: { agentArgsMode?: string | null; agentArgs?: string | null } | null | undefined,
  context?: { hasLegacyModelConfiguration?: boolean }
): TextGenerationCliArgsMode {
  if (
    recipe?.agentArgsMode === 'auto' ||
    recipe?.agentArgsMode === 'none' ||
    recipe?.agentArgsMode === 'custom'
  ) {
    return recipe.agentArgsMode
  }
  if (!hasAgentArgsKey(recipe)) {
    return context?.hasLegacyModelConfiguration ? 'none' : 'auto'
  }
  if (recipe?.agentArgs === null || (recipe?.agentArgs ?? '').trim() === '') return 'none'
  return 'custom'
}
```

This fallback is only for legacy data and rollback compatibility. New writes must include `agentArgsMode` for text-generation actions. Do not pass text-action recipes through a generic "complete recipe" helper that fills `agentArgs: ''` before the mode is derived. The model-configuration guard applies only when `agentArgsMode` is absent; explicit `agentArgsMode: 'auto'` always means Auto.

Runtime resolution must pass `hasLegacyModelConfigurationForTextAction(...)` into `textModeFromRecipe(...)` before compiling an Auto plan. Pseudocode that calls `textModeFromRecipe(actionRecipe)` is incomplete unless it is operating on an explicit-mode recipe or a test fixture that has intentionally disabled legacy compatibility.

Custom mode is "exact" at the CLI-token level, not a separate shell-language contract. Implementation may trim leading/trailing whitespace before tokenization, but it must preserve quoted args, escaped spaces, interior whitespace that affects tokenization, flag order, and duplicate flags. Do not normalize, dedupe, or parse model semantics out of Custom args.

Use one shared tokenizer contract for all Source Control AI custom CLI args. The current `tokenizeCustomCommandTemplate(...)` / `planAdditionalAgentArgs(...)` behavior is the baseline unless it is intentionally replaced everywhere. Settings validation, save blockers, renderer previews, local main-process generation, SSH/runtime generation, and launch-action suffix planning must agree on the same tokenization result and the same parse errors. Do not let the renderer accept a string that main/runtime later tokenizes differently.

Persist the raw Custom args string after trimming only leading/trailing whitespace for storage. Store and compare Custom state by mode plus raw string, not by reserialized tokens. Execution may tokenize the stored string into argv, but it must not round-trip the tokens back into a normalized string for persistence or dirty-state checks. Unterminated quotes or invalid escapes should block Save and Generate with the shared tokenizer error; they should not be repaired, dropped, or shell-executed as a fallback.

The UI derives text-action mode from `agentArgsMode` first and uses `textModeFromRecipe(...)` only to normalize legacy data. When reading legacy repository overrides, `agentArgs: null` is accepted only as rollback-compatible input and normalizes to None. New text-action writes should use `agentArgsMode: 'none'` and `agentArgs: ''` for None.

Writable normalization must upgrade rollback-compatible text-action `agentArgs: null` to explicit None before it ever drops null fields. Dropping `agentArgs: null` without writing `agentArgsMode: 'none'` changes a customized repo override from None into the legacy inherited-CLI-args state on the next save.

The UI derives a mode for launch actions:

```ts
type LaunchCliArgsMode = 'none' | 'custom'

function launchModeFromAgentArgs(agentArgs: string | undefined): LaunchCliArgsMode {
  return agentArgs && agentArgs.trim() ? 'custom' : 'none'
}
```

Repository overrides need one extra rule because the repo setting already has action-level inheritance:

```ts
type RepoTextGenerationCliArgsMode =
  | 'inherit'
  | 'legacy-inherit-cli-args'
  | 'auto'
  | 'none'
  | 'custom'

function repoTextModeFromOverride(
  hasActionOverride: boolean,
  recipe: { agentArgsMode?: string | null; agentArgs?: string | null } | null | undefined,
  context?: { hasLegacyModelConfiguration?: boolean }
): RepoTextGenerationCliArgsMode {
  if (!hasActionOverride) return 'inherit'
  if (
    recipe?.agentArgsMode !== 'auto' &&
    recipe?.agentArgsMode !== 'none' &&
    recipe?.agentArgsMode !== 'custom' &&
    !hasAgentArgsKey(recipe)
  ) {
    return 'legacy-inherit-cli-args'
  }
  return textModeFromRecipe(recipe, context)
}
```

This means a repository row has two layers:

- **Use global**: no `actionOverrides[actionId]`; inherit the whole global action recipe.
- **Customize**: `actionOverrides[actionId]` exists; new and explicitly saved rows own their CLI-args mode.
- **Legacy customized without CLI fields**: `actionOverrides[actionId]` exists, `agentArgsMode` is absent, and the `agentArgs` key is absent. Preserve the old runtime behavior by inheriting global CLI args until the user saves an explicit Auto/None/Custom mode.

There is intentionally no user-selectable "inherit global CLI args but customize only the command template" mode for text actions. Supporting that as a normal persisted mode would require a new field or an ambiguous sentinel. The `legacy-inherit-cli-args` state is read-only compatibility for old partial repo overrides, not a mode new UI can create.

Runtime resolution must follow the same rule. Once a repo text-action override has an explicit `agentArgsMode`, the override owns CLI args and must not fall through to `globalRecipe.agentArgsMode` or `globalRecipe.agentArgs`. The only fall-through case is the legacy compatibility state above; it must be labeled as legacy inheritance in UI. Saving unrelated repo settings must preserve that legacy state. Saving that action row must require the user to choose Auto, None, or Custom instead of silently guessing.

When the user switches a repository text-action row from **Use global** to **Customize**, the row may copy the effective agent and command template for editability, but it must not silently change the inherited CLI behavior. Initialize the new customized row from the effective global text mode as an owned draft:

- Inherited Auto becomes explicit repo Auto with `agentArgsMode: 'auto'` and `agentArgs: ''`.
- Inherited None becomes explicit repo None with `agentArgsMode: 'none'` and `agentArgs: ''`.
- Inherited Custom must not silently become Auto. Either prefill Custom args as an editable owned draft and require Save confirmation, or block Save until the user explicitly chooses Auto, None, or Custom. If copied, the args are no longer inherited after save; they are repo-owned Custom args.

This avoids creating a hidden per-field inheritance mode while also avoiding a surprise Custom -> Auto behavior change. Persist Auto rows with `agentArgsMode: 'auto'` and `agentArgs: ''` so a mode-stripping rollback cannot reinterpret the row as legacy inherited CLI args.

One-off generation dialogs need both recipe intent and resolved execution details:

```ts
type TextGenerationInvocationDraft = TextGenerationRecipeDraft & {
  resolvedAgentId: TuiAgent | CustomAgentId | null
  resolvedDisplayHostKey: string
  resolutionError?: string
}
```

`resolvedAgentId` is used for preview and execution when it is non-null. `resolutionError` blocks preview, Generate, and Save when the selected or default-followed agent cannot run text generation. `agentId` is what gets saved when the user chooses **Save defaults**. If a recipe opens as "Use default agent" and resolves to Codex, saving Auto must still write `{ agentId: null, agentArgsMode: 'auto', agentArgs: '' }`, not `{ agentId: 'codex', agentArgsMode: 'auto', agentArgs: '' }`, unless the user explicitly changes the agent select to Codex.

The agent select must make this distinction visible. When the recipe follows the default agent, show an option like:

> Use default agent (currently Codex)

The concrete `Codex` option is a separate pinning choice. Changing from "Use default agent (currently Codex)" to `Codex` is the explicit user action that allows saving `{ agentId: 'codex' }`.

Do not overload today's resolved execution params as the only dialog state. Add an invocation draft/wrapper, or extend the resolver output, so the dialog can carry:

- persisted recipe agent intent (`agentId`, including `null` for "Use default agent")
- resolved execution agent (`resolvedAgentId`)
- default-agent resolution error, when the current default cannot run text generation
- text CLI-args mode
- compiled execution params

The execution params may be concrete; the save params must preserve recipe intent.

`ResolvedSourceControlAiGenerationParams` may stay concrete for execution, but it cannot be the only object passed through **Save defaults**. Helpers such as `generationParamsToActionRecipe(...)` must accept recipe intent or be replaced for this flow; otherwise a default-agent recipe that resolves to Codex will be saved as pinned Codex.

Auto must also not be trusted as renderer-compiled execution state. A renderer preview may use the shared pure planner, but generation requests that use Auto must carry recipe intent/mode draft to the authoritative execution boundary and be compiled there. Do not send today's concrete `sourceControlAiResolvedParams` for Auto from the renderer to main/runtime/relay.

Phase one can use the existing generation APIs if Auto always chooses the settings-resolving path at the authoritative boundary. `ResolvedSourceControlAiGenerationParams` may remain the concrete execution shape after main/runtime/relay resolves the recipe, and it may remain a compatibility input for one-off None/Custom runs. Auto is not representable as pre-resolved params because it depends on current host, default-agent, command override, repo override, and settings state.

If a call site cannot use the existing settings-resolving path, add a narrow request shape for that call site:

```ts
type SourceControlTextGenerationInvocationRequest =
  | {
      kind: 'recipe'
      actionId: SourceControlTextActionId
      recipe: SourceControlTextActionRecipe
      customAgentCommand?: string
      repoId?: string
      sourceControlAiResolvedParams?: never
    }
  | {
      kind: 'precompiled'
      actionId: SourceControlTextActionId
      sourceControlAiResolvedParams: ResolvedSourceControlAiGenerationParams
      mode: Exclude<TextGenerationCliArgsMode, 'auto'>
    }
```

The `recipe` branch is the normal path for Auto. It carries persisted recipe intent (`agentId: null` still means "Use default agent") and lets main/runtime/relay resolve the current host, default agent, disabled-agent state, repo overrides, legacy commit-message model settings, actual command overrides, and static recommendation immediately before spawning. The `precompiled` branch is allowed only for None/Custom compatibility.

If a request provides `repoId`, the authoritative boundary must load that repo's current overrides for the target host or reject the request; it must not assume global settings are effective. Raw command override strings may cross execution requests because they are needed to spawn the command, but they must not be copied into persisted diagnostics or telemetry.

Required call-site inventory before enabling Auto in UI:

- Commit-message one-click generation from the Source Control panel.
- Commit-message generation used by "create PR from current changes" intent.
- Commit-message and pull-request text-generation dialogs.
- Pull-request details generation from the Create Pull Request dialog, including generate-on-open.
- Runtime RPC methods `git.generateCommitMessage` and `git.generatePullRequestFields`.
- Local IPC handlers `git:generateCommitMessage` and `git:generatePullRequestFields`.
- Headless `branchName` generation from `first-work-branch-rename.ts`, including SSH repo rename and local folder-title rename.

Every call site either uses host-side resolution for Auto or is covered by a test proving it cannot invoke Auto. Do not leave a renderer-resolved fast path that can accidentally bypass host-side Auto compilation. A future precompiled Auto protocol can be designed if a real use case appears; it is not part of phase one.

## Runtime Resolution

Text-generation actions first derive mode, then compile an effective runtime preset:

```ts
const mode = textModeFromRecipe(actionRecipe, {
  hasLegacyModelConfiguration: hasLegacyModelConfigurationForTextAction({
    actionId,
    resolvedAgentId,
    hostKey,
    sourceControlAi,
    legacyCommitMessageAi,
    repoOverrides,
    recipeSource
  })
})
const customAgentArgs =
  mode === 'custom'
    ? (actionRecipe.agentArgs ?? '')
    : ''

const cliArgsPlan =
  mode === 'auto'
    ? getRecommendedSourceControlTextCliArgsPlan(actionId, resolvedAgentId, hostKey)
    : mode === 'none'
      ? { mode, agentArgs: '' }
      : { mode, agentArgs: customAgentArgs }
```

Mode precedence over existing model settings is:

- **Explicit Auto**: ignore persisted `selectedModelByAgent`, host-scoped selected models, `modelOverridesByOperation`, and any persisted `selectedThinkingByModel` for the resolved text action. The Auto recommendation supplies both the model and thinking/mode choice for that invocation. If the recommendation omits a thinking level, use the recommended model's default thinking behavior, not a previously persisted user effort.
- **Guarded legacy missing-args Auto**: use Auto only when the legacy model-configuration guard says no model or thinking choice would be bypassed. If that guard finds existing model configuration, resolve the legacy recipe as None and preserve the existing selected-model path until the user explicitly chooses Auto.
- **None**: append no action-level CLI args and preserve the existing model-resolution path. This is the compatibility path for users who want old no-extra-action-args behavior.
- **Custom**: preserve the existing model-resolution path, then append user-authored CLI args verbatim. Duplicate flags are intentional user input and should not be rewritten.

This preserves legacy model preferences for None, Custom, and guarded legacy rows while ensuring truly untouched recipes actually get the new fast/economical Auto behavior.

Do not encode Auto by writing the recommendation's visible CLI string into `params.agentArgs`. In execution params, `agentArgs` remains append-only extra args for None/Custom/custom-command handling. Auto model and thinking choices should become structured plan input (`model`, `thinkingLevel`, and optional append-only extras) before `CommitMessageAgentSpec.buildArgs(...)` runs.

Launch actions:

```ts
const effectiveAgentArgs = actionRecipe.agentArgs ?? ''
```

Launch actions also keep existing TUI startup behavior:

- `agentDefaultArgs` remains separate from Source Control action-level `agentArgs`.
- Action-level launch args are validated/tokenized through `planAgentCliArgsSuffix(...)` and quoted for POSIX or PowerShell before terminal startup.
- Prompt delivery continues to come from `TUI_AGENT_CONFIG.promptInjectionMode` plus the selected Source Control delivery mode (`auto-submit`, `draft`, or `submit-after-ready`).
- Auto must not add model flags, change default launch args, bypass detection, or special-case any launch-only agent.

### Planning Detail

Auto recommendations are presented to users as CLI args, but they must not be appended naively when the recommendation is already represented by the non-interactive generation planner.

The planner should compile Auto recommendations into a clean final spawn plan:

- For agents whose `CommitMessageAgentSpec.buildArgs(...)` already emits a model flag, Auto must set `params.model` and `params.thinkingLevel` before `buildArgs(...)`.
- For Auto args that are not represented by existing plan input, Auto may append normal `agentArgs`.
- For Custom mode, keep the current literal append behavior. If a user types duplicate flags, Orca should not rewrite them.
- The command preview must be produced from the exact final binary and argv that execution will use.
- The same compiled plan must feed local main-process generation, SSH relay generation, runtime generation, and renderer previews. Do not maintain a renderer-only approximation of Auto.

This keeps the persisted recipe CLI-args based while avoiding confusing commands such as:

```sh
codex exec ... --model gpt-5.5 --model gpt-5.4-mini
```

Recommended implementation shape:

```ts
type SourceControlTextCliArgsDisplay =
  | { kind: 'cliArgs'; value: string }
  | { kind: 'presetDefault'; modelId: string; modelLabel: string }
  | { kind: 'noExtraArgs' }

type SourceControlTextCliArgsPlan =
  | {
      mode: 'auto'
      display: SourceControlTextCliArgsDisplay
      model?: string
      thinkingLevel?: string
      appendAgentArgs?: string
    }
  | { mode: 'none'; display: { kind: 'noExtraArgs' }; appendAgentArgs: '' }
  | { mode: 'custom'; display: { kind: 'cliArgs'; value: string }; appendAgentArgs: string }
```

`display` is semantic display data. It may render as CLI args even when the planner applies it by changing `model` and `thinkingLevel` instead of appending tokens. `appendAgentArgs` is the only part that should flow into today's literal `agentArgs` append path.

The shared planner must not return localized English sentences. Renderer/UI code should translate semantic display states such as `noExtraArgs` and `presetDefault`. Raw CLI snippets and model labels may pass through as data, but copy such as "no extra action-level CLI args" belongs in the localized renderer layer or another explicit i18n boundary.

The short display should describe the user-facing recommendation, not necessarily every final flag emitted by `buildArgs(...)`. For example, a model whose default thinking level is `low` may still render an effort flag in the planned argv preview. The short Auto preview should stay concise; the disclosure preview is where users see the full argv.

The preview should keep structured argv until render time:

```ts
type SourceControlTextCommandPreview = {
  binary: string
  args: string[]
  stdinPayload: string | null
}
```

For display, prefer a wrapped argv list. If the UI shows a single command line, it must be generated by a platform-aware escaping function from this structured preview. Do not use `[binary, ...args].join(' ')`; that misrepresents model names with spaces, command overrides, and Windows/SSH quoting.

Be precise about what the preview represents. A shared renderer preview can show the exact effective binary plus agent argv that Orca plans. On Windows, the OS spawn command may still differ after `.cmd` resolution and `cmd.exe` wrapping. If the UI promises an exact spawned command, that preview must come from the same main/runtime spawn transformation that execution uses; otherwise label it as the planned agent argv and keep the existing Windows `.cmd` caveat.

## Default Agent Rule

Auto may follow "Use default agent."

For text-generation actions, Custom non-empty CLI args should require a stable concrete target for new saves because custom args are target-specific. A concrete target can be a pinned text-generation agent or `agentId: 'custom'` with a non-empty custom command. It cannot be "Use default agent."

For `agentId: 'custom'`, Auto means no extra CLI args because Orca cannot infer model flags for arbitrary commands. Custom mode is still valid for custom commands: the args are appended through the existing custom-command planner and preserve the same tokenization rules as other Custom args.

Custom command validation follows the same scope as the recipe being executed or saved:

- Global settings row: use `sourceControlAi.customAgentCommand`; saving any `agentId: 'custom'` recipe requires it to be non-empty and tokenizable.
- Repository customized row: use the repo custom command when the repo custom-command mode is customized; otherwise use the inherited global custom command. Saving an `agentId: 'custom'` repo recipe requires the effective command for that repo scope to be non-empty and tokenizable.
- One-off dialog: use the dialog draft command if the user is editing a custom command, otherwise the effective command for the selected target. Generate and Save defaults both require the effective command to be non-empty and tokenizable, but Save must persist the command only when the user actually changed the command for that target.
- Runtime/SSH execution: revalidate the effective command on the host that will spawn it. A renderer preview that validated a local command does not prove a remote command override or custom command is valid.

If the effective custom command is missing or invalid, block Auto/None/Custom generation for `agentId: 'custom'` and show the existing custom-command validation error. Do not fall back to the default agent.

One-off generation may still run Custom args while the recipe says "Use default agent" as long as the current resolved agent supports text generation. In that case the dialog must show the compatibility warning and disable **Save defaults** until the user pins an agent or switches to Auto/None, but **Generate** may execute against the currently resolved agent. Text-generation settings rows have no one-off execution path, so they should block Save until the recipe is pinned or the args are cleared.

If the resolved default agent is unsupported for text generation, Auto should not fall back to a different agent silently. The generation dialog and settings row should show the support-boundary error and require the user to choose a supported text-generation agent. Disabled default agents may continue to use the existing fallback behavior.

This rule is about enabled, explicit defaults. If `settings.defaultTuiAgent` is `blank`, disabled, or missing, the existing hard fallback to the default commit-message provider may continue. If `settings.defaultTuiAgent` is enabled and points to a launch-only agent, text generation must stop with the support-boundary error so the user can fix the agent choice.

Allowed states:

```ts
// Follows the default agent and follows Orca's recommendation for that agent.
{ agentId: null, agentArgsMode: 'auto', agentArgs: '' }

// Follows the default agent and uses no extra action-level args.
{ agentId: null, agentArgsMode: 'none', agentArgs: '' }

// Locks to Codex and follows Orca's Codex recommendation.
{ agentId: 'codex', agentArgsMode: 'auto', agentArgs: '' }

// Locks to Codex and uses exact user-authored args.
{ agentId: 'codex', agentArgsMode: 'custom', agentArgs: '--model gpt-5.4-mini' }

// Uses an arbitrary custom command with no extra inferred CLI args.
{ agentId: 'custom', agentArgsMode: 'auto', agentArgs: '' }

// Uses an arbitrary custom command and exact extra args for that command.
{ agentId: 'custom', agentArgsMode: 'custom', agentArgs: '--json' }
```

New saves should block this state:

```ts
{ agentId: null, agentArgsMode: 'custom', agentArgs: '--model gpt-5.4-mini' }
```

Existing persisted recipes in that shape should continue to run for compatibility, but the settings UI should show a warning:

> Custom CLI args follow whichever default agent is active. Pick an agent for this recipe to make the args stable.

If Orca can resolve the current default agent, offer a one-click action:

> Pin to Codex

## Recommendation Table

The initial recommendations should be conservative and agent-specific. These are product defaults, not stored user choices. The values below are user-facing Auto previews; the exact planned argv preview must come from the compiled plan used for execution.

`Preset default` means "use the existing `CommitMessageAgentSpec.defaultModelId` and default thinking behavior," not "omit the model flag from the final command." The only exception is a spec that intentionally treats its default sentinel as "do not emit a model flag" in `buildArgs(...)`, such as Kimi's `default`.

The recommendation table should live in code as data, not as switch statements scattered through UI and runtime. Each entry should include `model`, optional `thinkingLevel`, optional append args, and a human display label. Tests should assert that every listed model/mode exists in the seeded spec catalog unless the recommendation is explicitly marked discovery-only.

| Agent          | Commit message                                    | Pull request details                              | Branch name                                       | Notes                                                                                                                       |
| -------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Codex          | `--model gpt-5.4-mini`                            | `--model gpt-5.4-mini`                            | `--model gpt-5.4-mini`                            | Compile by setting `model: 'gpt-5.4-mini'` before `codex exec` args are built.                                              |
| GitHub Copilot | `--model gpt-5.4-mini`                            | `--model gpt-5.4-mini`                            | `--model gpt-5.4-mini`                            | Compile by setting `model: 'gpt-5.4-mini'`; Copilot account policy may still reject it through the existing CLI error path. |
| Claude         | `--model haiku`                                   | `--model sonnet --effort low`                     | `--model haiku`                                   | PR details keep Sonnet because body quality is user-facing; commit and branch naming use Haiku.                             |
| OpenCode       | Preset default: `opencode/deepseek-v4-flash-free` | Preset default: `opencode/deepseek-v4-flash-free` | Preset default: `opencode/deepseek-v4-flash-free` | The preset already targets the free fast model; Auto should still be visible.                                               |
| Pi             | Preset default: `github-copilot/gpt-5.4-mini`     | Preset default: `github-copilot/gpt-5.4-mini`     | Preset default: `github-copilot/gpt-5.4-mini`     | The preset already targets the GitHub Copilot mini model.                                                                   |
| Amp            | `--mode rush`                                     | `--mode smart`                                    | `--mode rush`                                     | Compile by setting the Amp model/mode before `amp --execute` args are built.                                                |
| Cursor         | Preset default: `auto`                            | Preset default: `auto`                            | Preset default: `auto`                            | Cursor's `auto` model is the safest default because account policy decides availability.                                    |
| Kimi           | Preset default: `default`                         | Preset default: `default`                         | Preset default: `default`                         | Kimi's config default is user-managed and intentionally does not add `--model`.                                             |
| Antigravity    | `--model "Gemini 3.5 Flash (Low)"`                | `--model "Gemini 3.5 Flash (Medium)"`             | `--model "Gemini 3.5 Flash (Low)"`                | Quote display strings with spaces; compile by setting the model before `agy --print` args are built.                        |
| Custom command | no extra CLI args                                 | no extra CLI args                                 | no extra CLI args                                 | Orca cannot infer model flags for arbitrary commands.                                                                       |

Phase one uses this table as a hardcoded source of truth in shared code. Each entry maps `{ agentId, actionId }` to structured plan fields: optional `model`, optional `thinkingLevel`, optional append-only args, and semantic display data. The planner compiles that structure; it must not shell-split the visible preview string.

Treat a recommendation missing from the seeded `CommitMessageAgentSpec.models` table as a test failure, not a runtime fallback. For dynamic catalogs, the initial recommendation must still be present in the seeded spec table unless a future recommendation is explicitly marked discovery-only. The current recommendation table does not need any discovery-only entries.

If the user's account or host rejects the recommended model, use the existing CLI error path. Do not add host-scoped discovery fallback, command-override fingerprints, discovered default-model persistence, or model-list telemetry in phase one. Future work may add dynamic unavailable-model fallback after there is a product need and a privacy-safe discovery provenance design.

## UI Design

The design should preserve Orca's quiet settings style: dense, explicit, low decoration, token colors, shadcn controls, and no new color semantics beyond foreground, muted, border, accent, destructive, and ring.

UX principle: make the state visible where the action happens. Users should not need to know fallback rules to understand why Auto is selected. Legacy compatibility states should be labeled as compatibility states. Every editable text-generation surface should show the selected mode, the resolved agent, and the short consequence in plain language.

### Settings: Text-Generation Action Row

For `commitMessage`, `pullRequest`, and `branchName`, replace the single raw `CLI arguments` input with a mode control plus contextual preview.

Layout:

```text
Commit message                                      [Agent select]
Generate the commit message from staged changes.

CLI arguments
[ Auto ] [ None ] [ Custom ]
Auto for Codex
--model gpt-5.4-mini

Command template
[ textarea ]
[basePrompt] [branch] [stagedFiles] [stagedPatch]

Saved                                             [Save]
```

Control behavior:

- Use `SettingsSegmentedControl` from `src/renderer/src/components/settings/SettingsFormControls.tsx` for Settings rows. Dialogs may use the existing shadcn `ToggleGroup` single-select pattern if that better matches adjacent dialog controls. Do not hand-roll a new segmented-control style for `Auto`, `None`, and `Custom`.
- Explicit saved rows select `Auto`, `None`, or `Custom` from `agentArgsMode`.
- Legacy rows select their mode from resolver-provided metadata that already applied `hasLegacyModelConfigurationForTextAction(...)`; the renderer must not call `textModeFromRecipe(recipe)` without the guard context.
- Dialogs and settings drafts should carry this resolved mode separately from the raw custom args string, then persist an explicit `agentArgsMode` on save.
- The row's draft state must store `mode` separately from the custom args input value. Do not initialize the row with `agentArgs ?? ''` and derive mode later.
- The `Custom` text input appears only in Custom mode.
- Auto and None show read-only mono preview text, not an editable input.
- Auto preview must be generated from the same compiled plan that execution uses; do not reuse a placeholder string.
- If Auto is selected and the agent select is "Use default agent", the preview should show the currently resolved agent while the saved recipe still follows the default agent.
- If the resolved agent changes because the default agent changes, any untouched Auto row should update its preview without becoming dirty.
- The row summary should include the resolved meaning, for example:
  - `Auto for Codex: --model gpt-5.4-mini`
  - `Auto for OpenCode: preset default opencode/deepseek-v4-flash-free`
  - `None: no extra action-level CLI args; configured model still applies`
  - `Custom for Codex: --model gpt-5.4-mini --foo`
- If "Use default agent" resolves to an unsupported text-generation agent, show the support-boundary error inline and disable Save; on generation surfaces, disable Generate too.
- Do not show "Saved" for a blocked row. Use a blocking copy state such as `Choose a supported agent to save`.

Suggested visible copy:

- Auto helper:
  > Orca picks fast CLI args for the selected agent. If the default agent changes, Auto follows it.
- None helper:
  > Add no extra action-level CLI args. The agent's configured model still applies.
- Custom helper:
  > Use exact CLI args for this recipe.
- Default-agent custom blocker:
  > Custom CLI args are specific to an agent. Choose an agent for this recipe to save custom args.

Accessibility and interaction:

- The segmented control must be keyboard reachable.
- Each mode must have a text label, not icon-only presentation.
- The mono preview should use `font-mono text-xs text-muted-foreground`.
- The Custom input should keep `spellCheck={false}`, `autoCorrect="off"`, and `autoCapitalize="off"`.
- Errors and blockers should be inline with `text-destructive`, not tooltip-only.

### Settings: Launch Action Row

For `fixCommitFailure`, `fixChecks`, `resolveConflicts`, and `resolveComments`, do not show Auto.

Layout:

```text
Broken checks fixes                               [Agent select]
Start an agent from failed hosted-review checks.

CLI arguments
[ input ]

Command template
[ textarea ]
```

Behavior:

- Missing and empty `agentArgs` both mean no extra args.
- Do not show recommended model text.
- If a user enters launch args while the agent select is "Use default agent", keep the existing launch recipe behavior: the args follow the current default launch agent. This Auto design must not add text-generation pinning rules to launch rows.
- The launch row's command preview, when present, should continue using `planSourceControlAgentActionLaunch(...)` / `buildAgentStartupPlan(...)` so all `TUI_AGENT_CONFIG` prompt-injection modes are represented correctly.

### Text-Generation Dialog

The one-off generation dialog should use the same mental model as Settings.

Layout:

```text
Agent
[ Use default agent (currently Codex) v ]

CLI arguments
[ Auto ] [ None ] [ Custom ]
Auto for Codex
--model gpt-5.4-mini

Command template
[ textarea ]

[Save defaults] [Generate]
```

Required behavior:

- Opening the dialog with an untouched recipe shows Auto, not an empty input.
- Opening the dialog must preserve the recipe's agent selection separately from the resolved agent used for planning.
- The agent select distinguishes following the default agent from pinning the currently resolved agent. `Use default agent (currently Codex)` and `Codex` are separate choices.
- The dialog's initial state must come from the saved recipe plus resolver metadata, not only from `baseParams`. `baseParams.agentId` is the resolved execution agent and is not safe as the persisted selection.
- Saving defaults from Auto writes `agentArgsMode: 'auto'`, writes `agentArgs: ''`, and removes stale non-empty `agentArgs`.
- Saving defaults from None writes `agentArgsMode: 'none'` and `agentArgs: ''`.
- Saving defaults from Custom writes `agentArgsMode: 'custom'`, token-preserving args, and requires a stable concrete target.
- Custom mode is valid only when the custom args contain non-whitespace text. If the field is blank, the user should choose None instead.
- Saving defaults from a recipe that still says "Use default agent" must preserve `agentId: null`. Do not save the resolved concrete agent unless the user explicitly chooses that agent in the dialog.
- Custom mode with "Use default agent" may Generate once against the currently resolved concrete agent, but Save defaults is disabled until the user pins an agent or switches to Auto/None.
- Generate without saving uses the selected mode for that invocation.
- The generate button remains the primary action.
- If **Save defaults** is disabled but **Generate** is allowed, the disabled save control needs inline text explaining why; do not leave users guessing.
- Add a compact command preview disclosure below CLI arguments:
  > Preview command
- The preview must show the exact planned binary and argv after Auto compilation.
- The preview must render quoted/spaced args correctly. A command-line string is acceptable only if it is generated from structured argv with platform-aware escaping; otherwise render an argv list.
- The preview should be read-only, mono, and clipped/wrapped safely.
- Keep the preview collapsed by default in the dialog; Auto's short preview should be visible without expanding it.

### Repository Overrides

Repository Source Control AI rows should keep the existing action-level switch:

- `Use global`: no repo action override; inherit the whole global action recipe.
- `Customize`: create a repo action override; the row now owns agent, command template, and CLI-args mode.

Within a customized text-generation row, mirror the global Auto/None/Custom modes:

- Auto: repo override with `agentArgsMode: 'auto'`, `agentArgs: ''`, and no stale non-empty `agentArgs`.
- None: repo override with `agentArgsMode: 'none'` and `agentArgs: ''`.
- Custom: repo override with `agentArgsMode: 'custom'` and non-empty `agentArgs`.
- Legacy inherited CLI args: old partial repo override with no `agentArgsMode` and no `agentArgs` key. This state is visible and executable for compatibility, but it is not offered as a selectable mode and cannot be produced by new writes.

Important write rule: customized repo text rows must preserve their chosen mode even when saved through `toSourceControlAiRepoUpdate(...)`. Auto writes `agentArgsMode: 'auto'` and `agentArgs: ''`; None writes `agentArgsMode: 'none'` and `agentArgs: ''`; Custom writes `agentArgsMode: 'custom'` and the exact custom string. The writable-normalization path must not drop `agentArgsMode` or the empty string for Auto or None.

Rollback-compatible text rows with `agentArgs: null` are the only null-input exception. They read as None, and the first write of that row or any whole-repo normalization that rewrites the row must emit explicit None rather than omitting the CLI fields.

The UI should avoid confusing global inheritance with Auto. Use separate row-level and field-level labels:

```text
Recipe
[ Use global ] [ Customize ]

CLI arguments
[ Auto ] [ None ] [ Custom ]
Auto for Codex
--model gpt-5.4-mini
```

When a repo row uses global settings, show the resolved inherited preview in the row summary:

> Inherits global Auto for Codex: --model gpt-5.4-mini

When a repo row is customized, do not show an "inherit CLI args" option for new edits. That option cannot be represented unambiguously without adding a new persisted field.

When the user changes a text row from `Use global` to `Customize`, initialize the mode from the effective inherited mode and make ownership explicit. If inherited global mode is Custom, do not silently show or save Auto; show the inherited Custom args as a pending owned draft or require the user to choose Auto, None, or Custom before saving.

Existing legacy customized repo rows with no `agentArgsMode` and omitted `agentArgs` must render as a compatibility state, for example:

> Legacy inherited CLI args from global settings

If the global recipe currently resolves to Auto, the summary can include that inherited consequence:

> Legacy inherited global Auto for Codex: --model gpt-5.4-mini

If the global recipe currently resolves to Custom, the summary must not silently relabel the row as Auto. It should show the inherited Custom args and prompt the user to choose Auto, None, or Custom before saving. Dirty-state checks and save buttons must compare Auto and None as different states.

## Migration And Rollout

Use the product-forward approach without an eager migration. The phase-one implementation may ship behind one non-mutating compatibility gate if existing config plumbing already supports it:

- **Legacy Auto default gate**: when disabled, legacy missing-args recipes behave as None while explicit Auto/None/Custom recipes keep their saved meaning.

If no config mechanism exists, do not add one only for this feature. Rely on internal/beta validation plus the fact that explicit user saves can choose None or Custom. If `legacyAutoDefaultEnabled` exists and is false, `textModeFromRecipe(...)` must treat missing legacy text-action `agentArgsMode` plus missing `agentArgs` as None without mutating saved recipes.

1. Do not write an eager migration that fills every existing text-action recipe.
2. Split fresh settings creation from legacy read normalization before writing any Auto defaults. New profiles may persist explicit Auto; existing profiles must not gain explicit Auto from read normalization or unrelated saves.
3. New text-action writes must persist `agentArgsMode`.
4. Legacy recipes with no `agentArgsMode`, no `agentArgs`, and no model/thinking configuration that Auto would bypass read as Auto.
5. Legacy recipes with no `agentArgsMode` and `agentArgs: ''` read as None.
6. Legacy repo overrides with `agentArgs: null` read as None for rollback compatibility.
7. Legacy recipes with no `agentArgsMode` and non-empty `agentArgs` read as Custom.
8. For existing text-generation non-empty args with `agentId: null`, allow execution but show the compatibility warning and block further saves until the recipe is pinned or the args are cleared.
9. Existing legacy customized repo text-action rows with no `agentArgsMode` and omitted `agentArgs` keep legacy CLI-args inheritance until saved. They must render as a compatibility state, not Auto or None.
10. Update text-action normalizers, draft state, equality checks, and save logic so Auto and None remain distinct by mode. Launch actions may continue to collapse missing and empty `agentArgs` to no extra args.
11. Update repo text-action resolution so explicitly saved customized rows do not inherit global `agentArgsMode` or `agentArgs`. A customized row owns its mode after the first explicit Auto/None/Custom save.
12. Update one-off dialog state so resolved execution params cannot overwrite persisted recipe intent when saving defaults.
13. Update command-preview helpers so the short preview and exact preview are both generated from the same structured plan used for execution.
14. Ensure Auto invocations use the settings-resolving path, or a narrow recipe request when needed, instead of renderer-originated `sourceControlAiResolvedParams`.
15. Compile Auto at the authoritative execution boundary for local, SSH, and runtime generation.
16. Add focused launch non-regression coverage proving text-generation Auto does not alter terminal launch rows or `buildAgentStartupPlan(...)`.
17. Optional telemetry may record privacy-safe mode/source/unsupported-agent categories if the product needs rollout visibility. Telemetry is not required for phase one, and it must not include prompts, diffs, repo paths, command args, command overrides, model lists, or raw errors.

This changes behavior for truly untouched global text-generation recipes. It does not silently override existing model/thinking preferences and does not silently change legacy customized repo text-generation rows whose CLI fields were omitted; those rows preserve old inheritance until the user picks and saves an explicit mode. The UI must make Auto visible anywhere the user can inspect or edit the recipe, and any subsequent save should write the explicit `agentArgsMode`.

Rollout copy for release notes or in-app changelog:

> Source Control AI commit-message, pull-request, and branch-name generation now uses Auto CLI args by default for untouched recipes. Auto picks faster args for the selected agent, such as Codex `--model gpt-5.4-mini`. Existing configured model choices are preserved until you explicitly choose Auto. You can switch any global or repository recipe to None or Custom in Settings.

## SSH And Remote Runtime

Recommendations must be resolved against the host that will run the CLI:

- Local worktree: local host key.
- SSH worktree: SSH host key.
- Runtime environment: runtime host key.

Auto should be compiled as structured plan input at the host that will run the CLI, not by shell-splitting the visible preview string and not by trusting renderer-resolved concrete params. This matters for Windows quoting, SSH relay execution, runtime default-agent state, command overrides, and model names with spaces such as Antigravity's `Gemini 3.5 Flash (Low)`.

The command preview must also be rendered from structured argv, not a whitespace join. This matters even when execution is correct, because a misleading preview makes users copy/debug the wrong command.

For settings pages that are not scoped to a worktree, show the local/default-host preview and label it as such:

> Auto for Codex on this machine: --model gpt-5.4-mini

For action dialogs opened from an SSH or runtime worktree, show the host-scoped preview:

> Auto for Codex on SSH host: --model gpt-5.4-mini

Do not assume local model discovery applies to SSH. Phase one does not use discovery data to override Auto recommendations; it uses the static recommendation for the active host and lets the CLI error path report account or host rejection. Renderer previews for SSH/runtime may be advisory, but execution must re-resolve Auto against the active SSH/runtime host immediately before spawning.

Command overrides still apply after Auto resolves the agent/model plan. Auto must not assume the binary is literally `codex`, `claude`, or another default executable when `settings.agentCmdOverrides` supplies a wrapper.

The structured preview should represent command overrides as the actual executable plus prefix args that will be spawned. If an override is invalid, Auto preview should surface the existing override validation error instead of silently falling back to the default binary.

## All-Agent Compatibility

Text-generation Auto must technically work with every CLI agent Orca supports by respecting the support boundary:

- For `COMMIT_MESSAGE_AGENT_SPECS` agents, Auto compiles into that spec's existing non-interactive planner. It must not invent ad hoc argv per agent outside the spec.
- For `custom`, Auto compiles to no extra args and still validates the custom command template through the existing custom-command tokenizer/planner.
- For launch-only agents, Auto is absent. Their source-control launch rows keep the existing raw CLI args field, host detection, enabled-state checks, prompt delivery mode, command overrides, and POSIX/PowerShell quoting.
- For agents in both registries, text-generation Auto must not mutate their terminal launch defaults. A Codex Auto commit-message recommendation must not add `--model gpt-5.4-mini` to a later Codex TUI launch.
- For SSH and runtime hosts, support is decided on that host. A locally detected/supported agent or model does not prove remote availability.

No implementation should special-case only Claude/Codex and assume the rest are fine. The launch registry and text registry both need automated coverage.

## Implementation Plan

1. Add a shared module for Source Control text CLI-args recommendations.
   - Suggested name: `src/shared/source-control-text-cli-args.ts`.
   - Export mode derivation, repo mode derivation, static recommendation lookup, semantic display data, and a structured Auto compile result.
   - Export registry assertions that cover every `COMMIT_MESSAGE_AGENT_SPECS` entry plus `custom`, every `SOURCE_CONTROL_TEXT_ACTION_IDS` entry, and every recommendation model/mode id in the seeded spec catalog.
   - Keep this module shared/pure so main-process generation, SSH relay generation, runtime generation, and renderer previews can use the same plan.
   - Do not return localized English copy from this shared module; UI-facing sentences are rendered at the i18n boundary from semantic display states.
   - Do not name it `helpers` or `utils`.
2. Update text-generation resolution.
   - Apply Auto only for `commitMessage`, `pullRequest`, and `branchName`.
   - Leave launch actions unchanged.
   - Resolve the action agent first, then apply the Auto recommendation for that resolved agent and host.
   - In explicit Auto mode, override selected-model settings for that action. In guarded legacy missing-args mode, preserve selected-model resolution when `hasLegacyModelConfigurationForTextAction(...)` finds an existing model/thinking choice for the same action, agent, host, and repo/global scope.
   - If the default agent is unsupported for text generation, surface the existing unsupported-agent error instead of silently falling back.
   - For repo customized text actions with explicit `agentArgsMode`, read the mode from the repo override and do not inherit global CLI fields.
   - For legacy customized text actions with no `agentArgsMode` and no `agentArgs` key, preserve legacy global CLI-args inheritance until the user saves an explicit mode.
   - Cover headless `branchName` resolution from `first-work-branch-rename.ts` for SSH repo branch rename and local folder-title rename.
3. Update planning to compile Auto recommendations without duplicate built-in model flags.
   - Auto can set existing plan model/thinking inputs before `buildArgs`.
   - Custom remains appended verbatim.
   - Do not tokenize Auto's visible preview text; use structured model/thinking/append fields.
   - Return structured preview data (`binary`, `args`, `stdinPayload`) and render it with an argv-aware display helper.
   - Add a single display helper for previews, for example `formatSourceControlTextCommandPreview(platform, plan)`, so renderer, main-process diagnostics, SSH, runtime, and tests do not invent separate quoting rules.
4. Update `SourceControlActionRecipeRow`.
   - Text actions use Auto/None/Custom segmented mode.
   - Launch actions keep simple CLI args behavior with no Auto recommendation.
   - Text-action draft state stores `mode` separately from the custom args string.
5. Update `SourceControlTextGenerationDialogForm`.
   - Use the same mode control and save semantics.
   - Carry recipe agent selection separately from resolved execution agent so saving can preserve "Use default agent."
   - Replace save comparisons that derive a recipe only from concrete generation params; they need recipe intent plus resolved execution params.
6. Update repository override rows.
   - Keep row-level `Use global` separate from customized-row Auto/None/Custom.
   - When creating a customized text override, initialize from the inherited effective CLI mode as an owned draft and never silently convert inherited global Custom args to Auto.
   - Ensure customized text rows persist `agentArgsMode` for Auto, None, and Custom.
   - Ensure customized legacy text rows with no `agentArgsMode` and omitted `agentArgs` summarize as legacy inherited CLI args, not Auto or "No args."
   - Preserve legacy inherited CLI args when saving unrelated repo settings; require an explicit mode choice before saving changes to that action row.
7. Add compatibility warnings for legacy text-generation custom args on default-agent recipes.
8. Update save logic.
   - Split fresh creation, read normalization, and write normalization. Fresh creation persists explicit text-action Auto. Read normalization preserves legacy missing fields. Write normalization persists only explicit writes and must not serialize inferred Auto during unrelated saves.
   - Add mode-aware text-action save/update entry points, or make existing generic entry points require the action id and sanitize text/launch shapes before persistence.
   - Auto writes `agentArgsMode: 'auto'`, writes `agentArgs: ''`, and removes stale non-empty `agentArgs`.
   - None writes `agentArgsMode: 'none'` and `agentArgs: ''`.
   - Text-action Custom writes `agentArgsMode: 'custom'`, the user's token-preserving arg string, and pins or requires a stable concrete target.
   - Custom args and custom commands use the shared tokenizer for validation, preview, save blockers, and execution on local, SSH, and runtime hosts.
   - Text-action comparisons treat `agentArgsMode` as the primary state and use legacy `agentArgs` derivation only when the mode is absent.
9. Compile Auto at the authoritative execution boundary.
   - One-click generation, text-generation dialogs, runtime RPC, local IPC, and headless branch-name generation must not send renderer-originated Auto `sourceControlAiResolvedParams`.
   - Existing None/Custom precompiled params may remain where they are already used for one-off generation.
   - Type and test save/update boundaries so launch actions cannot persist `agentArgsMode`.
10. Keep future hardening out of phase one.
   - Do not add discovery provenance, model-unavailable fallback, command fingerprints, emergency Auto kill switches, or telemetry unless a separate product/runtime requirement already exists.
   - If telemetry is added later, it must omit prompts, diffs, repo paths, command args, command overrides, model lists, and raw errors.

## Test Plan

Phase-one gates:

- Pass shared mode derivation, fresh/read/write normalization split, mode-aware save API, no eager legacy migration, Custom tokenizer, command preview, authoritative Auto invocation, unsupported-default-agent, repo override inheritance, one-off dialog save-intent, SSH/runtime host-scoped compilation, and launch non-regression tests.
- Run manual QA across at least one local worktree and one SSH/runtime worktree before broad rollout.

Shared tests:

- `agentArgsMode: 'auto'` resolves to Auto recommended args and ignores the empty rollback sentinel `agentArgs: ''`.
- `agentArgsMode: 'none'` resolves to no extra action-level args.
- `agentArgsMode: 'custom'` resolves as user-authored Custom args and requires non-empty `agentArgs`.
- Text-action read/save paths preserve the difference between Auto and None by mode.
- Text-action write boundaries listed in this document all persist `agentArgsMode` on new writes.
- Public text-action save APIs accept `agentArgsMode`; public launch-action save APIs reject/drop `agentArgsMode` and launch writes cannot persist it through runtime normalization.
- Fresh settings writes persist explicit Auto for text actions, while legacy normalization alone does not eagerly write `agentArgsMode` back into old recipes during unrelated settings saves.
- `createFreshSourceControlAiSettings(...)`, `normalizeSourceControlAiSettingsForRead(...)`, and `normalizeSourceControlAiSettingsForWrite(...)` have separate tests proving fresh creation persists Auto, read normalization preserves missing legacy fields, and write normalization does not serialize inferred Auto unless the action row was explicitly saved.
- Generic action recipe write helpers are either not exported for persistence or reject text/launch shape mismatches at compile time and runtime schema boundaries.
- Saving Custom -> Auto clears stale persisted `agentArgs` to `''`; saving Auto is not implemented as a shallow merge that leaves old non-empty args behind.
- Legacy text-action recipes with no `agentArgsMode`, missing `agentArgs`, and no model/thinking configuration resolve to Auto.
- Legacy text-action recipes with no `agentArgsMode`, missing `agentArgs`, and existing model/thinking configuration resolve as None with compatibility copy until the user explicitly chooses Auto.
- Legacy model-configuration guard tests cover same action/agent/host/scope positives and cross-action/cross-agent/cross-host/cross-scope negatives.
- Legacy text-action recipes with no `agentArgsMode` and empty `agentArgs` resolve to None.
- Legacy text-action recipes with no `agentArgsMode` and non-empty `agentArgs` resolve to Custom.
- `agentArgs: null` in a legacy repo text-action override resolves to None for rollback compatibility.
- Any writable normalization of a repo text-action row with rollback-compatible `agentArgs: null` emits explicit `agentArgsMode: 'none'` and `agentArgs: ''` rather than dropping the field into legacy inheritance.
- A customized repo text-action override with `agentArgsMode: 'auto'` resolves to Auto, not inherited global Custom args.
- A customized repo text-action override with `agentArgsMode: 'auto'` writes and preserves `agentArgs: ''`; if a rollback/mode-stripping path removes `agentArgsMode`, the row degrades to None instead of legacy inherited CLI args.
- A customized repo text-action override with no `agentArgsMode` and omitted `agentArgs` preserves legacy inheritance from global CLI args until saved.
- A customized repo text-action override with explicit `agentArgsMode` does not fall through to global `agentArgsMode` or `agentArgs` in `resolveSourceControlAiForOperation(...)` or `resolveSourceControlActionRecipe(...)`.
- Switching a repo text action from Use global to Customize while global mode is Custom does not silently initialize or save Auto; it either pre-fills an owned Custom draft or blocks Save until the user explicitly chooses a mode.
- Saving unrelated repository Source Control AI settings preserves legacy inherited CLI args instead of normalizing them to Auto/None/Custom.
- Launch actions do not receive Auto recommendations.
- Auto with default agent follows the resolved default agent.
- Auto with an unsupported default agent shows the unsupported text-generation agent error.
- Explicit Auto ignores selected-model settings for the action and uses the recommendation.
- Explicit Auto ignores legacy and new `selectedThinkingByModel` overrides for the action and uses the recommendation/default thinking behavior.
- Guarded legacy missing-args mode preserves selected-model and selected-thinking behavior when such configuration exists.
- None and Custom preserve the existing selected-model resolution.
- Recommendation registry tests cover every text-generation agent, every text action, and every recommended model/mode id in the seeded `CommitMessageAgentSpec` catalog.
- Runtime RPC, preload API types, main-process persistence, and repo normalization preserve text-action `agentArgsMode` and the Auto/None `agentArgs: ''` sentinel.
- The support-copy test derives its supported-agent list from `listCommitMessageAgentCapabilities()` plus `custom`, not a duplicated hard-coded string.
- Existing text-generation custom args with default agent remain executable but are marked unsafe for saving.
- Custom command Auto with a non-empty custom command resolves to no extra CLI args and does not infer a model flag.
- Custom command Custom mode accepts non-empty extra args when `agentId: 'custom'` has a non-empty custom command, and still blocks saving Custom args with `agentId: null`.
- Custom command validation uses the effective command for the global, repo, one-off, local, SSH, and runtime scope being executed; missing or invalid effective commands block `agentId: 'custom'` instead of falling back.
- Custom args preserve quotes, escaped spaces, flag order, and duplicate flags through save, comparison, preview, and execution planning.
- Custom args with invalid quoting or escapes produce the same shared tokenizer error in settings, dialogs, local generation, SSH/runtime generation, and launch-action planning.
- If a legacy Auto default gate exists, it makes legacy missing-args recipes resolve through the no-extra-args compatibility path without mutating saved recipes.

Planner tests:

- Codex Auto produces one effective model flag for `gpt-5.4-mini`, not duplicate model flags.
- Custom Codex args remain appended verbatim, even if duplicate flags exist.
- Claude Auto commit/branch uses Haiku; PR details uses Sonnet low.
- OpenCode, Pi, Cursor, and Kimi Auto preserve their preset defaults without appending duplicate flags.
- Amp Auto maps commit/branch to Rush and PR details to Smart through the existing `--mode` planner input.
- Antigravity Auto handles model names with spaces without shell-splitting the display string.
- Agent command overrides still wrap the final Auto command correctly.
- Command preview exposes structured binary/argv/stdin data and does not use whitespace joining for display.
- Command preview tests cover POSIX, Windows/PowerShell display, Windows `.cmd` resolution caveats, command overrides with prefix args, model names containing spaces, and whether the UI labels the preview as planned agent argv versus exact OS spawn command.
- Renderer-originated Auto `sourceControlAiResolvedParams` are rejected or bypassed in favor of host-side settings resolution.
- Every listed generation call site uses host-side resolution for Auto: Source Control one-click commit generation, create-PR-intent commit generation, text-generation dialogs, Create Pull Request generate-on-open, runtime RPC, local IPC, and headless `branchName` generation from `first-work-branch-rename.ts`.
- Branch-name Auto tests cover SSH repo branch rename and local folder-title rename; neither path depends on renderer dialog state.
- Launch action planning is unchanged.
- Registry-derived launch tests cover every launch-capable `TuiAgent`: launch rows never show Auto, missing/empty args mean no extra args, custom args are shell-quoted on POSIX and Windows, and submit-after-ready delivery never embeds generated prompt text in argv.
- For agents present in both `TUI_AGENT_CONFIG` and `COMMIT_MESSAGE_AGENT_SPECS`, Auto affects only text-generation planning and never changes `buildAgentStartupPlan(...)` output for terminal launches.
- SSH/remote execution receives the same final plan as local planning for a given host-scoped recommendation.

Renderer tests:

- Settings rows render Auto when `agentArgsMode: 'auto'`.
- Settings rows render Auto for legacy untouched text actions with no `agentArgsMode`, no `agentArgs`, and no model/thinking configuration that Auto would bypass.
- Settings rows render None when `agentArgsMode: 'none'`.
- Settings rows render Custom input when `agentArgsMode: 'custom'`.
- Settings row draft state keeps Auto selected after editing another field in an untouched text action.
- Custom mode with "Use default agent" shows the save-blocking compatibility copy.
- Save defaults from Auto writes `agentArgsMode: 'auto'`, writes `agentArgs: ''`, and removes stale non-empty `agentArgs`.
- Save defaults from None writes `agentArgsMode: 'none'` and `agentArgs: ''`.
- Save defaults from Custom writes `agentArgsMode: 'custom'`, token-preserving args, and a stable concrete target.
- Text-generation dialog matches settings mode behavior.
- Text-generation dialog opened from "Use default agent" saves `agentId: null` when the user does not explicitly pin an agent.
- Text-generation dialog renders "Use default agent (currently X)" separately from the concrete `X` option.
- Text-generation dialog recomputes the Auto preview when "Use default agent" resolves to a different agent, without marking the recipe dirty.
- Text-generation dialog can generate with the resolved concrete agent while saving the original recipe agent selection.
- Text-generation dialog can save Auto/None/Custom without using `baseParams.agentId` as the persisted recipe agent when the original recipe was "Use default agent."
- Text-generation dialog permits one-off Generate for Custom + Use default agent, but disables Save defaults until an agent is pinned or the mode changes.
- Repository override UI distinguishes Inherit from Auto.
- Repository customized rows with `agentArgsMode: 'auto'` summarize as Auto, not "No args."
- Repository legacy customized rows with no `agentArgsMode` and omitted `agentArgs` summarize as legacy inherited CLI args, not Auto or "No args."
- Repository legacy customized rows require choosing Auto/None/Custom before saving edits to that action row, while unrelated repo setting saves preserve the legacy row.
- Repository customized None persists `agentArgsMode: 'none'` and `agentArgs: ''`.
- Unsupported default-agent text rows show the blocking copy and disable Save; generation surfaces disable Generate too.
- Command preview displays exact structured argv for Auto, None, and Custom modes, including args with spaces.

Manual QA:

- Fresh profile with Codex default: commit-message generation shows and uses Auto `--model gpt-5.4-mini`.
- Change default agent from Codex to Claude: default-agent text recipes update their Auto preview.
- Change default agent to an unsupported text-generation agent such as Aider: text actions show the support-boundary error and launch actions still work.
- Switch a recipe to None: generation adds no action-level CLI args and preserves the configured model path.
- Switch a text-generation recipe to Custom: saving requires a stable concrete target.
- Open a default-agent Auto dialog, generate once, save defaults, and verify the recipe still follows the default agent.
- Existing text-generation recipe with default agent plus custom args shows compatibility warning.
- Fix checks and resolve conflicts still start the default agent with no recommended model args.
- Launch a representative launch-only agent and a representative dual-surface agent from a Source Control launch action; verify neither receives Auto text-generation args.
- Repeat at least one SSH worktree path and verify the preview names the remote host behavior.
- Run one dry-plan check each for Claude, Codex, OpenCode, Pi, Amp, Cursor, Kimi, Copilot, Antigravity, and Custom command.

## Resolved Decisions

- Claude PR details use Sonnet low; Claude commit messages and branch names use Haiku.
- Amp PR details use Smart; Amp commit messages and branch names use Rush.
- The text-generation dialog shows Auto's short preview inline and exposes the planned argv behind a collapsed disclosure.
- The dialog saves recipe intent, not merely resolved execution params; "Use default agent" remains `agentId: null`.
- One-off Custom args may run with the current default agent, but saving those args requires choosing a stable concrete target.
- Repository customized rows do not offer per-field CLI-args inheritance. Use global inherits the whole recipe; Customize owns Auto/None/Custom.
- Explicit Auto overrides selected-model settings; guarded legacy missing-args rows preserve the existing selected-model path when model/thinking configuration exists.
- Phase one uses the static recommendation table and lets the CLI error path report account or host rejection. Dynamic unavailable-model fallback is future work.
