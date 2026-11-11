import type { RepoTerminalViewAttributesByHost } from '../../../../shared/repo-terminal-view-attributes-by-host'
/**
 * Phase 5 slice 2 (View-attribute bridge): main-side cache of the renderer's
 * `pty:terminalViewAttributes` (global) and `pty:repoTerminalViewAttributes`
 * (per-project terminalTheme, keyed by execution host then repo id) pushes. Per-pane font
 * zoom never affects these, so a PTY's effective snapshot is its project's on its host, else
 * the global one. Folder workspaces and the floating terminal deliberately fall back to global;
 * paired-runtime projects are never in the map.
 *
 * Before the renderer's pushes, a host with a window pre-loads the same snapshots from its
 * persisted settings and projects (the seed), so a hidden PTY's OSC 4/12 and ?996n are
 * answered from app start; the renderer's publish of equal values is then a no-op. A host
 * without a seed stays silent until the first push. OSC 10/11 never reach the responder
 * from a current PTY owner, which answers them itself from the viewer colours below and
 * the per-repo colours the listeners forward to it.
 */
import {
  repoAttributesToViewerColors,
  repoMapsByHostEqual,
  toRepoAttributesByHost,
  type RepoAttributesByHost
} from './repo-terminal-view-attribute-map'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  parseXColorSpec,
  terminalViewAttributesEqual,
  validateTerminalViewAttributes,
  terminalViewColorQueryReplyColors,
  type RepoTerminalViewAttributesPayload,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import {
  cssColorToOscRgb,
  type TerminalOscColorQueryReplyColors
} from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import {
  colorQueryReplyColorsEqual,
  normalizeColorQueryReplyColors,
  repoColorQueryReplyColorsByHostEqual,
  type PtyOwnerRepoColorsByHost
} from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import { getTerminalThemeRepoId } from '../../../../shared/repo-terminal-theme'
import {
  getConnectionTerminalThemeHostId,
  type TerminalThemeHostId
} from '../../../../shared/terminal-theme-execution-host'

// IPC stores shared attributes; runtime emulators read them at reply time.
let currentAttributes: TerminalViewAttributes | null = null
// Null until the renderer's first repo push, which then always reaches the PTY owners.
let repoAttributesByHost: RepoAttributesByHost | null = null

/** What main composes from persisted settings and projects before the renderer publishes. */
export type TerminalViewAttributesSeed = {
  global: TerminalViewAttributes
  byHostId: RepoTerminalViewAttributesByHost
}
let seedAttributes: TerminalViewAttributes | null = null
let seedRepoAttributes: RepoAttributesByHost | null = null
let seedSource: (() => TerminalViewAttributesSeed | null) | null = null

// Why drop empty hosts: "no themed project there" is spelled by absence everywhere else.
/** Which PTY is asking: its worktree id and SSH connection (null = local). */
export type TerminalViewAttributeScope = {
  worktreeId: string | null
  connectionId: string | null
}

// All panes share viewer colors; use this host's window, or paired-client push on a headless host.
let pairedViewerColors: TerminalOscColorQueryReplyColors | null = null
let pairedAttributes: TerminalViewAttributes | null = null
let seedColors: TerminalOscColorQueryReplyColors | null = null
let viewerColorsListener: ((colors: TerminalOscColorQueryReplyColors) => void) | null = null
let repoViewerColorsListener: ((byHost: PtyOwnerRepoColorsByHost) => void) | null = null

/** One push as the appliers see it. */
export type TerminalViewAttributesPush = {
  /** 'base-learned' = first arrival of a slot (nothing on screen changed), so OSC SET overlays stay. */
  kind: 'theme-change' | 'base-learned'
  /** The attributes a PTY in this scope answered from before the push. */
  resolveBefore: (scope: TerminalViewAttributeScope | null) => TerminalViewAttributes | null
}

// Why appliers (pattern of registerConptyDa1OverrideInstaller): each push
// must also reach already-live emulators — cursor options under the replay
// guard, plus the per-PTY override reset a theme apply implies. Appliers
// resolve each PTY's effective snapshot themselves via the scope getter.
type TerminalViewAttributesApplier = (push: TerminalViewAttributesPush) => void
const pushAppliers = new Set<TerminalViewAttributesApplier>()

export function registerTerminalViewAttributesApplier(
  applier: TerminalViewAttributesApplier
): void {
  pushAppliers.add(applier)
}

/** The renderer's pushes and main's seed, as one resolution input. */
type AttributeSources = {
  global: TerminalViewAttributes | null
  byHost: RepoAttributesByHost | null
  seedGlobal: TerminalViewAttributes | null
  seedByHost: RepoAttributesByHost | null
}

function currentSources(): AttributeSources {
  return {
    global: currentAttributes ?? pairedAttributes,
    byHost: repoAttributesByHost,
    seedGlobal: seedAttributes,
    seedByHost: seedRepoAttributes
  }
}

/** The host and repo whose theme a PTY in this scope follows; null where only global applies. */
function themeRepoScope(
  scope: TerminalViewAttributeScope | null | undefined
): { hostId: TerminalThemeHostId; repoId: string } | null {
  if (!scope || scope.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const repoId = getTerminalThemeRepoId(scope.worktreeId)
  return repoId ? { hostId: getConnectionTerminalThemeHostId(scope.connectionId), repoId } : null
}

function resolveRepoAttributes(
  scope: TerminalViewAttributeScope | null | undefined,
  sources: AttributeSources
): TerminalViewAttributes | null {
  const target = themeRepoScope(scope)
  // Why the seed only before the renderer's map: once pushed, a repo it omits is unthemed.
  const byHost = sources.byHost ?? sources.seedByHost
  return (target ? byHost?.get(target.hostId)?.get(target.repoId) : undefined) ?? null
}

function resolveAttributesForScope(
  scope: TerminalViewAttributeScope | null | undefined,
  sources: AttributeSources
): TerminalViewAttributes | null {
  return resolveRepoAttributes(scope, sources) ?? sources.global ?? sources.seedGlobal
}

/** Captures the pre-push state so appliers can tell a palette change from a base merely learned. */
function beginPush(kind: TerminalViewAttributesPush['kind']): () => void {
  const sources = currentSources()
  const push: TerminalViewAttributesPush = {
    kind,
    resolveBefore: (scope) => resolveAttributesForScope(scope, sources)
  }
  return () => {
    for (const applier of pushAppliers) {
      applier(push)
    }
  }
}

/** Called from the pty:terminalViewAttributes IPC handler with a validated
 *  payload. Last push wins (replies always use the freshest snapshot). */
export function setTerminalViewAttributes(attributes: TerminalViewAttributes): void {
  // Why idempotent: the renderer publisher's dedupe is per-process, so a
  // fresh renderer (second window, reload, macOS re-activation) re-pushes
  // identical attributes. That is not a theme apply — fanning out would wipe
  // every PTY's OSC SET overlay while visible panes keep theirs.
  // Why the seed counts: the renderer confirming main's pre-load changed nothing on screen.
  const known = currentAttributes ?? seedAttributes
  if (known && terminalViewAttributesEqual(known, attributes)) {
    currentAttributes = attributes
    return
  }
  const before = getTerminalViewerColors()
  const commit = beginPush(currentAttributes ? 'theme-change' : 'base-learned')
  currentAttributes = attributes
  commit()
  notifyIfViewerColorsChanged(before)
}

/** Called from the pty:repoTerminalViewAttributes IPC handler with a validated payload.
 *  Replaces the whole map, every host at once (absent host or repo = global). */
export function setRepoTerminalViewAttributes(payload: RepoTerminalViewAttributesPayload): void {
  const next = toRepoAttributesByHost(payload.byHostId)
  // Why idempotent: same reason as the global push (fresh renderer re-push, seed confirmed).
  const known = repoAttributesByHost ?? seedRepoAttributes
  if (known && repoMapsByHostEqual(known, next)) {
    repoAttributesByHost = next
    return
  }
  const before = getRepoTerminalViewerColorsByHost()
  const commit = beginPush(repoAttributesByHost ? 'theme-change' : 'base-learned')
  repoAttributesByHost = next
  commit()
  notifyIfRepoViewerColorsChanged(before)
}

/** The renderer's global push; null before it (the seed is not reported here). */
export function getTerminalViewAttributes(): TerminalViewAttributes | null {
  return currentAttributes ?? pairedAttributes
}

/** A paired client's full appearance; a host window's own push wins. */
export function setPairedViewAttributes(attributes: TerminalViewAttributes): void {
  if (pairedAttributes && terminalViewAttributesEqual(pairedAttributes, attributes)) {
    return
  }
  const commit = beginPush('theme-change')
  pairedAttributes = attributes
  if (currentAttributes) {
    return
  }
  commit()
}

/** Effective snapshot for one PTY: its project's on its host when themed, else global; the
 *  renderer's push where known, else main's seed, else null (silence). */
export function getTerminalViewAttributesForScope(
  scope: TerminalViewAttributeScope | null
): TerminalViewAttributes | null {
  return resolveAttributesForScope(scope, currentSources())
}

export function getTerminalViewColorQueryReplyColors(
  scope?: TerminalViewAttributeScope | null
): TerminalOscColorQueryReplyColors | null {
  const attributes = getTerminalViewAttributesForScope(scope ?? null)
  return attributes ? terminalViewColorQueryReplyColors(attributes) : null
}

/** The colours OSC 10/11 answer with on this host: the PTY's project theme, else its own
 *  window (published or pre-loaded), else a paired client, else the saved theme. */
export function getTerminalViewerColors(
  scope?: TerminalViewAttributeScope | null
): TerminalOscColorQueryReplyColors | null {
  return getTerminalViewColorQueryReplyColors(scope) ?? pairedViewerColors ?? seedColors
}

/** Spawn colours for a terminal the runtime creates in this workspace. */
export function getWorkspaceTerminalViewerColors(workspace: {
  id: string
  connectionId?: string | null
}): TerminalOscColorQueryReplyColors | null {
  return getTerminalViewerColors({
    worktreeId: workspace.id,
    connectionId: workspace.connectionId ?? null
  })
}

/** A paired client's theme, from terminal.setViewerColors or the colours on terminal.create. */
export function setPairedViewerColors(colors: TerminalOscColorQueryReplyColors): void {
  const before = getTerminalViewerColors()
  pairedViewerColors = colors
  // A colours-only pusher (an older client) has no palette; another client's would contradict these colours.
  if (
    pairedAttributes &&
    !sameColors(terminalViewColorQueryReplyColors(pairedAttributes), colors)
  ) {
    pairedAttributes = null
  }
  notifyIfViewerColorsChanged(before)
}

/** Spawn args that pin a paired creator's theme to its new PTY, whose owner then answers every theme query with it. */
export type PairedLauncherSpawnArgs = {
  launcherColorQueryReplies?: TerminalOscColorQueryReplyColors
  launcherViewAttributes?: TerminalViewAttributes
}

/** Admit terminal.create's theme (older clients report it only there). Pin it only where this host's window outranks
 *  it host-wide (#34340); elsewhere the host-wide theme already is the creator's and follows its later pushes. */
export function admitPairedCreateColors(
  value: unknown,
  attributesValue?: unknown
): PairedLauncherSpawnArgs {
  const colors = normalizeColorQueryReplyColors(value)
  if (!colors) {
    return {}
  }
  const candidate = validateTerminalViewAttributes(attributesValue)
  // A palette for another theme would contradict these colours; an older creator sends none.
  const attributes =
    candidate && sameColors(terminalViewColorQueryReplyColors(candidate), colors) ? candidate : null
  setPairedViewerColors(colors)
  if (attributes) {
    setPairedViewAttributes(attributes)
  }
  if (!currentAttributes) {
    return {}
  }
  return {
    launcherColorQueryReplies: colors,
    ...(attributes ? { launcherViewAttributes: attributes } : {})
  }
}

function cssColorRgb(value: string | undefined): TerminalViewRgb | null {
  return parseXColorSpec(cssColorToOscRgb(value) ?? '')
}

function sameColors(
  a: TerminalOscColorQueryReplyColors,
  b: TerminalOscColorQueryReplyColors
): boolean {
  const key = (colors: TerminalOscColorQueryReplyColors): string =>
    JSON.stringify([cssColorRgb(colors.foreground), cssColorRgb(colors.background)])
  return key(a) === key(b)
}

/** The saved theme, answering until a viewer reports its colours. */
export function seedTerminalViewerColors(colors: TerminalOscColorQueryReplyColors): void {
  const before = getTerminalViewerColors()
  seedColors = colors
  notifyIfViewerColorsChanged(before)
}

function notifyIfViewerColorsChanged(before: TerminalOscColorQueryReplyColors | null): void {
  const colors = getTerminalViewerColors()
  if (colors && !colorQueryReplyColorsEqual(before, colors)) {
    viewerColorsListener?.(colors)
  }
}

/** One listener: the PTY IPC layer re-installs it on macOS re-activation. */
export function setTerminalViewerColorsListener(
  listener: ((colors: TerminalOscColorQueryReplyColors) => void) | null
): void {
  viewerColorsListener = listener
}

/** OSC 10/11 colours per themed project, by execution host: the renderer's map once pushed,
 *  else main's seed from persisted repos, or null before either. */
export function getRepoTerminalViewerColorsByHost(): PtyOwnerRepoColorsByHost | null {
  const byHost = repoAttributesByHost ?? seedRepoAttributes
  return byHost ? repoAttributesToViewerColors(byHost) : null
}

function notifyIfRepoViewerColorsChanged(before: PtyOwnerRepoColorsByHost | null): void {
  const byHost = getRepoTerminalViewerColorsByHost()
  if (byHost && !(before && repoColorQueryReplyColorsByHostEqual(before, byHost))) {
    repoViewerColorsListener?.(byHost)
  }
}

/** Where the seed comes from (persisted settings + projects + OS appearance); re-read on refresh.
 *  Null on a host with no window: paired clients paint its panes with their own theme. */
export function setTerminalViewAttributesSeedSource(
  source: (() => TerminalViewAttributesSeed | null) | null
): void {
  seedSource = source
  refreshTerminalViewAttributesSeed()
}

/** Re-reads the seed after persisted settings, projects or the OS appearance changed. */
export function refreshTerminalViewAttributesSeed(): void {
  // Why skip once the renderer has published both: nothing answers from the seed any more, and
  // reading the source hydrates every persisted project row.
  if (!seedSource || (currentAttributes && repoAttributesByHost)) {
    return
  }
  const next = seedSource()
  // Why keep the last seed: settings can be briefly unavailable; an empty map would wipe every
  // project's colours from the owners.
  if (!next) {
    return
  }
  const nextByHost = toRepoAttributesByHost(next.byHostId)
  if (
    seedAttributes &&
    seedRepoAttributes &&
    terminalViewAttributesEqual(seedAttributes, next.global) &&
    repoMapsByHostEqual(seedRepoAttributes, nextByHost)
  ) {
    return
  }
  const colorsBefore = getTerminalViewerColors()
  const repoColorsBefore = getRepoTerminalViewerColorsByHost()
  // Why theme-change on a re-seed: PTYs already answered from the old seed, as from a push.
  const commit = beginPush(seedAttributes ? 'theme-change' : 'base-learned')
  seedAttributes = next.global
  seedRepoAttributes = nextByHost
  commit()
  // Why repo first: the owner's first push then carries the project map with the host colours.
  notifyIfRepoViewerColorsChanged(repoColorsBefore)
  notifyIfViewerColorsChanged(colorsBefore)
}

/** Called on every repo-map change so each host's PTY owner answers its projects' colours. */
export function setRepoTerminalViewerColorsListener(
  listener: ((byHost: PtyOwnerRepoColorsByHost) => void) | null
): void {
  repoViewerColorsListener = listener
}

/** Test seam: reset module state between tests. */
export function _resetTerminalViewAttributesForTest(): void {
  currentAttributes = null
  repoAttributesByHost = null
  pushAppliers.clear()
  pairedViewerColors = null
  pairedAttributes = null
  seedColors = null
  seedAttributes = null
  seedRepoAttributes = null
  seedSource = null
  viewerColorsListener = null
  repoViewerColorsListener = null
}
