# Keybinding token downgrade safety

A shortcut binding is stored as a string (`Mod+Shift+P`, `MouseBack`). A build that predates
a token cannot parse it. That alone is fine — what is not fine is what the readers do next.

## The failure this prevents

Both stores keep one array per action, and both used to throw the whole array away when a
single entry failed to normalize:

- `src/main/keybindings/keybinding-file-parser.ts` (`~/.orca/keybindings.json`)
- `src/renderer/src/web/preload-api/web-keybindings-api.ts` (paired web app, `localStorage`)

So saving `["Mod+Shift+P", "MouseBack"]` and then running an older build dropped
`Mod+Shift+P` as well. On the desktop that loss lasted as long as the downgrade; on web it
was **permanent**, because an older bundle rewrites its whole document from its own parsed
view and never sees the entry it dropped. #23287 shipped this and was reverted in #23350.

## The two rules

**1. A new token is persisted in a section older builds ignore.** Mouse bindings never go in
`keybindings` or `platforms.<os>`. They go in a parallel section, and readers rejoin the two
into one list per action:

| Store | Keyboard bindings | Mouse bindings |
| --- | --- | --- |
| Desktop file | `keybindings`, `platforms.<os>` | `mouse.keybindings`, `mouse.platforms.<os>` |
| Web `localStorage` | `orca.web.keybindings.v1` | `orca.web.keybindingsMouse.v1` |

A desktop root key is enough because an older build's write spreads the document it read and
only replaces `version`, `keybindings`, and `platforms` — an unknown root key survives. The
web bundle instead rebuilds a fresh `{version, keybindings, platforms}` object, which would
destroy an unknown key, so the web split needs its own storage key.

`splitBindingsByInputKind` / `unionKeybindingOverrides` in
`src/shared/keybindings/mouse-bindings.ts` are the only places that know the layout is split.
Everything above the two stores — conflict detection, Settings, matching — sees one list.

Corollaries worth keeping:

- An action whose only binding is a mouse button is written as `[]` in the keyboard section,
  not omitted. An older build must read it as "no keyboard shortcut", not "use the default".
- The section is omitted while it is empty, and pruned when its last entry goes, so a file
  that never had a mouse binding gains no new shape.
- Settings writes are platform-scoped, so both halves of an edit land in the active
  platform's section. The pre-existing rule that a platform section masks the common one
  still applies, now within each kind.

**2. A read drops the entry, never the action.** `normalizeStoredKeybindingArrayForAction`
normalizes each stored entry on its own and reports the rejects, matching what
`getEffectiveKeybindingsForAction` already did downstream. If nothing survives, the action is
left unset so it falls back to its defaults rather than reading as deliberately unbound.

Rule 1 protects builds that already shipped. Rule 2 is what keeps the next new token from
repeating the regression, and it is the rule to lean on — do not rely on rule 1 alone being
applied correctly forever.

## Before you add a binding token

1. Decide which store persists it and give it its own section under rule 1. A token that only
   ever appears in a hand-authored file still needs this, because Settings round-trips the
   file.
2. Cover the downgrade directly: write the binding, then assert the keyboard bindings survive
   with the new section removed. `keybinding-file-mouse-section.test.ts` and
   `web-preload-api-keybindings-mouse.test.ts` do this; removing the section is the faithful
   stand-in for a build that cannot see it.
3. Check the reverse direction too: an older build writing an unrelated action must not
   disturb the new section.
