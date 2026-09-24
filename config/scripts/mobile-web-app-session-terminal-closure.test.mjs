import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { mobileWebAppRouteChunkClosure } from './mobile-web-app-route-chunk-closure.mjs'
import {
  editableHostFontSizeOffenders,
  editableHostsIn,
  unresolvedEditableHostStyles
} from './mobile-web-app-editable-host-font-size.mjs'
import {
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './mobile-web-app-text-input-font-size-seam.mjs'

/**
 * What putting the terminal on the page costs the session route's closure.
 *
 * The route is not served on the page until C7.7 — its module is still the native switch and
 * there is no `.web.tsx` beside it — but the closure the bundler would walk is the same one, and
 * the terminal is by far the largest thing in it. Measured here so the trade is a number rather
 * than a claim, and so that a later change cannot quietly put the engine string back.
 *
 * Re-anchored on main at 4a3a32206d, the squash that landed C7.5b, and re-measured there. The
 * reading has been re-taken at each merge rather than adjusted, because the arithmetic keeps not
 * working: main has re-pinned this count three times for modules that arrived from three other PRs,
 * and a number carried forward would have been wrong about every one of them.
 *
 *   modules        4286 -> 4328   (+42)
 *   local modules   936 ->  978   (+42)
 *
 * The +42 is this lane's, and it is 43 modules in and one out. Out:
 * `terminal-webview-document-factory.generated.ts`, the one emitted file C7.5b's page imported,
 * which carried the whole document. In: the document's 39 source modules the page imports directly
 * under ruling 25, the three page modules their tap group reaches — `terminal-webview-url-tap`,
 * `terminal-path-tap` and `terminal-file-url-tap` — which the generator used to substitute as
 * literals, and `terminal-text-scales`, the leaf the presets moved to so the WebView's own bundle
 * cannot reach `storage/preferences` and the AsyncStorage import behind it. Nothing generated is in
 * this reading now: the phone's script is built from these same modules and is not imported here.
 *
 * The three modules the base gained, none of them this branch's and all of them in its 4286 by
 * main's own route:
 *
 * - `src/mobile-web-shell/bridge/bridge-haptics-notify.ts`, which `haptics.web.ts` reaches. C7.10
 *   item E (#21864) and mermaid (#21871) were each green against a main that lacked the other, so
 *   main held 4323 while measuring 4324, and #21908 re-pinned it there.
 * - `src/mobile-web-shell/bridge/bridge-page-route-grants.ts` and the
 *   `mobile-web-bundle/manifest-contract.ts` whose grant grammar it imports rather than restates,
 *   both C2.9's. They reach every page closure through `bridge-envelope.ts`, which the page reads
 *   to parse `init`, so this count moves for any route the page serves and not for the session
 *   alone.
 *
 * Which is the point of re-measuring rather than summing. The merged total was one above the sum
 * the first time, when main had drifted the haptics module after recording its own number, and a
 * sum would have read 4283 and been wrong about a module neither side of that merge touched.
 *
 * Both sides read with `mobileWebAppRouteClosure(SESSION_ROUTE)` and every postinstall generator
 * `mobile/package.json` names run first — five at this reading, since C7.10 C1 added the rich
 * Markdown editor's document, and the list is read there rather than counted from here because it
 * grows. The before side is a scratch worktree detached at the same sha, and the
 * three modules above read out of the after side's list by name rather than inferred from the
 * total. Measured rather than taken from main's pin because the pin covers only the module count,
 * so the local count beside it would otherwise be a number nobody had read.
 *
 * The byte reading is not re-measured and stays anchored where it was taken, against main at
 * ec82173130: 3,768,122 -> 3,766,312 minified (-1,810). `mobileWebAppRouteClosure` reads
 * `metafile.inputs` and returns no byte total, so a figure produced here would be a different
 * computation rather than a newer reading of that one.
 *
 * The bytes fall because threading the scope deletes a closure: every function names its state as a
 * parameter, and a parameter minifies to one character where a shared module-level object could not.
 * Folding the seventeen never-written fields out of that object takes the rest: a constant read
 * through `scope.X` is a property access the minifier must keep, and the same constant as a module
 * `const` is inlined.
 *
 * What moved is which files carry the document, not whether the page carries it. C7.5 put the
 * document's own source modules in this closure and started them per mount; ruling 23 gave the
 * page the factory the WebView's script was generated from, so the same program arrived as one
 * emitted file and its 41 inputs leave. The bytes barely move because it is the same program: what
 * goes is the import and export plumbing between the modules, and what the generator substitutes.
 *
 * The two commits inside the -40, because only one of them is the factory arriving: making the
 * document a factory put the `host` argument on `createTerminalDocumentScope`, the lane's only edit
 * to a module this closure already carried, and cost 80 bytes on its own -- 3,768,202 measured at
 * that commit. The -1,890 from there is the page importing the emitted factory instead.
 *
 * xterm was already a static import of the mount before this, so nothing here is xterm arriving: it
 * and its two addons are 607,945 bytes minified ESM on their own, and they are on both sides of the
 * reading above.
 *
 * Two earlier readings of the same measurement, against the bases this branch sat on before:
 * -47,255 at 51ae7b1b03 and -55,561 at 0ce0fc99a2. They differ because C7.1's own round-1 fold
 * deleted `URL_TAP_WEBVIEW_JS` from a module only the page's component brings into this closure,
 * so the saving lands on the after side and no base can show it.
 *
 * Then C7.10 item B put mermaid on the page, and the module list moved again. Its own reading, at
 * the base it was taken against:
 *
 *   modules        4320 -> 4323   (+3)
 *   local modules   970 ->  973   (+3)
 *
 * Three modules: the configuration both hosts read, the loader, and the pre-bundled engine the
 * loader imports on demand. The engine's own 66 files and the d3, dagre, katex and cytoscape trees
 * under them are inside that one artifact rather than in this graph, which is why the count barely
 * moves. Importing the package here instead read +2,056 and emitted 103 scripts, a package
 * splitting along its own lazy diagram-type boundaries -- every one of them inside the OTA generation
 * the phone had already downloaded, so the split moved no bytes and spent 103 of the 256 manifest
 * assets the shell will load. One artifact costs one script and one module.
 *
 * What the generation weighs, because every chunk ships in it whether or not a phone ever fetches
 * one: the built bundle is 8,016,714 bytes across 112 assets, against the 9 MiB ceiling in
 * `verify-mobile-web-app-bundle.mjs`. That is 84.9% of it, with 1,420,470 bytes left for the rest
 * of C7.10 and for C7.7. Before item B the same bundle was 4,539,090 bytes, and the engine is the
 * difference -- deferring it defers evaluation and a fetch, never the download.
 *
 * `mobileWebAppRouteClosure` reads `metafile.inputs`, which holds dynamically imported modules
 * under `splitting: true` just as it does under `splitting: false`, so it cannot express "on
 * demand" about anything. Ruling 28: the fence for this route is `entryStaticClosure`, which
 * follows `import-statement` edges only, and the module list's total is a recorded number rather
 * than a budget. It moves whenever main adds a module this route reaches, and is re-recorded rather
 * than argued with.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')

const SESSION_ROUTE = 'app/h/[hostId]/session/[worktreeId].tsx'

/** Gone with the WebView: string literals of a program the page has no way to run. */
const SHED = [
  'src/terminal/TerminalWebView.tsx',
  'src/terminal/terminal-webview-engine.generated.ts',
  'src/terminal/terminal-webview-document-script.generated.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-html/document-shell.ts',
  'src/terminal/terminal-webview-html/document-close.ts'
]

/** The component, its mount, the stylesheet and the markup, and the modules the splits made. */
const GAINED_OUTSIDE_THE_DOCUMENT = [
  'src/terminal/TerminalWebView.web.tsx',
  'src/terminal/terminal-web-document-mount.ts',
  'src/terminal/terminal-webview-engine-css.generated.ts',
  'src/terminal/terminal-webview-html.web.ts',
  'src/terminal/terminal-webview-html/document-markup.ts',
  'src/terminal/terminal-webview-html/document-style.ts',
  'src/terminal/terminal-webview-ready-promises.ts',
  'src/terminal/use-terminal-webview-controller.ts',
  // The page's half of the stylesheet: the document-level rules are dropped and the rest is held
  // under the host, so what the page injects can only reach what the terminal owns. It sits
  // outside `src/terminal/` because the rich Markdown editor's mount reads the same rewrite.
  'src/style-scoping/document-style-scoping.ts'
]

const XTERM_PACKAGES = ['@xterm/xterm', '@xterm/addon-unicode11', '@xterm/addon-webgl']

/**
 * The 16 px seam's verdict for this route, which C7.5 must leave exactly where C7.2 left it.
 *
 * Design §3 counted nine inputs under the floor here and C7.2 moved all nine onto the seam, so the
 * answer is now none. Asserted rather than left unmeasured because the terminal's own modules
 * joining this closure is precisely the kind of change that could add a tenth unread.
 */
const EXPECTED_OFFENDERS = 0

/** The deferred engine, as the page reaches it: one artifact, not the package's own file tree. */
const MERMAID_PAGE_ENGINE = 'src/components/pr-sidebar/mermaid-page-engine.generated.ts'
const MERMAID_PACKAGE = 'node_modules/mermaid/'

/**
 * The module list on the merge, recorded at the base in the docstring above, which is where every
 * part of it is accounted for: the document's own modules replacing the factory that carried them,
 * mermaid's three, and the three bridge modules #21908 and C2.9 pin on main.
 *
 * Then C7.10 item D put dictation's capture on the page, and the list moved down rather than up.
 *
 *   modules        4328 -> 4323   (-5)
 *   local modules   978 ->  981   (+3)
 *
 * Three local modules join — `src/platform/dictation-capture.web.ts`, its contract
 * `src/platform/dictation-capture-contract.ts`, and the verb shapes in
 * `src/mobile-web-shell/bridge/bridge-audio-verbs.ts` — and eight vendored ones leave, because the
 * capture seam is what stops the page importing a microphone it does not have. Five are
 * `@orca/expo-two-way-audio` (its web module, `core`, `events`, `hooks` and the index) and three
 * are `expo-keep-awake`; the page asks the shell for the microphone over
 * `native.audio.start|read|stop` instead, and never asks about the screen at all — an open mic
 * holds it on the device side. The native halves of the seam resolve out of this closure entirely,
 * which is the -8 + 3.
 *
 * Measured, not derived: `mobile-web-app-session-dictation-capture.test.mjs` moves the web file
 * aside and walks the closure again, which puts those eight back.
 *
 * C7.7 registers the route and adds one more: the walk now enters through
 * `app/h/[hostId]/session/[worktreeId].web.tsx` rather than the native switch, and reaches
 * `src/session/MobileSessionRouteScreen.tsx` under it — the route file is one input either way and
 * the component is the one that is new.
 *
 * The number below is re-measured rather than summed, which is what the reading above kept having
 * to do: C7.7 measured 4,328 -> 4,329 against `23207bfde2` and item D measured 4,328 -> 4,323
 * against a different base, and neither side's arithmetic survives the other. The merge with main
 * read 4,324 modules and 982 local — one more than the 4,323 / 981 item D pinned, and that one is
 * C7.7's route body, read out of `ROUTE_ENTRY` below by name rather than inferred.
 *
 * Round 1 re-measured it at 4,326 / 984. The two were named rather than counted:
 * `notification-pane-tab.ts`, which both siblings of the pane hook read (a `.web.ts` cannot import
 * its native neighbour by the plain path — the bundler answers with itself), and
 * `bridge-init-route.ts`, the route half of `init` split out of an envelope that was at its line
 * cap. The pane hook's own web sibling replaces the native file rather than joining it, so it
 * costs nothing.
 *
 * Ruling 34 measures 4,330 / 988, and the four are named the same way. `bridge-frame-fields.ts`
 * and `bridge-notify-envelope.ts` are the two halves an envelope back at its line cap was split
 * into; the page-to-shell union in the second names the param the page may erase, which is
 * declared beside the route-update accept, so `bridge-route-update.ts` and the
 * `shell-screen-route.ts` it reads a route key from now enter through the envelope as well. All
 * four are schema and string constants: the closure grew, the download did not gain a package.
 *
 * Main measures 4,333 at `3cfb070294`: #21924 (`2739246058`) turned `agent-session-wire.ts`'s
 * type-only import of `agent-session-record` into a value import, so `src/shared/agent-session-record.ts`
 * and the two it reaches, `agent-session-conversation-name.ts` and `surrogate-safe-text-slice.ts`,
 * entered the page bundle between C7.7's measurement on `f07bf8544c` and its merge. Named by
 * diffing the closure at `f07bf8544c` against `2739246058`; nothing on the C7.7 side moved.
 *
 * Then C7.10 item C put the rich Markdown editor on the page, and the list moved again. Its own
 * reading, both sides measured with `mobileWebAppRouteClosure(SESSION_ROUTE)` at base `9267423f22`
 * with all five postinstall generators run first:
 *
 *   modules        4333 -> 4360   (+27)
 *   local modules   991 -> 1018   (+27)
 *
 * Every one of the 27 is local and none is vendored, because the editor is the app's own code
 * rather than a library: the document's 24 modules under `src/components/rich-markdown/` — which
 * C7.6's plain field did not reach at all — plus the page's mount, the toolbar both siblings render,
 * and the controller and keyboard-inset module the native component already had. Nothing leaves:
 * the web sibling replaces its own native file, which was never in this closure. Named by diffing
 * the two `local` lists rather than inferred from the total.
 *
 * `style-scoping/document-style-scoping.ts` is in the reading on both sides and costs
 * nothing: the terminal's own mount already brings it, and the editor's mount imports the second
 * export it grew rather than a module of its own.
 *
 * What the generation weighs, measured the same way on both sides: 8,028,418 -> 8,056,166 bytes
 * (+27,748) across 109 assets, against the 9 MiB ceiling in `verify-mobile-web-app-bundle.mjs` —
 * 85.1% of it before and 85.4% after. The script count does not move at all (67, against the
 * 76 the chunk fence allows for 15 routes) and neither does the entry's static closure
 * (1,612,052 bytes against a 3 MiB bound): the editor is code the session route already reached
 * for, not a new chunk boundary.
 *
 * Main's own paragraph for the same pin, kept because the two provenances are independent: ruling
 * 36 gave the screen to the microphone and two local modules left,
 * `src/hooks/mobile-dictation-keep-awake.ts` and
 * `src/hooks/mobile-dictation-foreground-keep-awake.ts`, the page's wake-tag owner and its Android
 * foreground re-acquire. Both are deleted rather than moved — the device module that opens the
 * microphone takes the screen and gives it back — so the page has nothing left to own.
 *
 *   modules        4333 -> 4331   (-2)
 *   local modules   991 ->  989   (-2)
 *
 * Then the two other table parsers gave up their own row splitters and read the editor's
 * `src/components/rich-markdown/markdown-table-rows.ts` instead, which the session page reaches
 * through the PR comment renderer. It is the one module that joins, and the only one it can be: it
 * imports nothing, and no other file under `rich-markdown/` is in the closure beside it.
 *
 *   modules        4331 -> 4332   (+1)
 *   local modules   989 ->  990   (+1)
 *
 * Then #18790 (`0677271709`) taught the agent icon table a new agent, and its icon
 * `src/shared/agent-icons/freebuff.png` entered through `mobile-agent-icon-assets.ts`, which the
 * session page reaches as it reaches every other icon there. An image asset, not a package, and
 * the one line that differs between the closure at `226f4a0775` and at `059ee59a48`; it landed
 * between #22114's measurement and its merge, so main read one short.
 *
 *   modules        4332 -> 4333   (+1)
 *   local modules   990 ->  991   (+1)
 *
 * C7.10 item C then put the whole of that directory on the page, and the merge of the two is
 * measured rather than summed — which is what this reading keeps having to do. The arithmetic of
 * 4,358 on this branch and 4,332 on main double-counts `markdown-table-rows.ts`: main reached it
 * first through the comment renderer, and it is also one of the 27 the editor brings. Measured on
 * the merged head with every generator run first:
 *
 *   modules        4333 -> 4359   (+26)
 *   local modules   991 -> 1017   (+26)
 *
 * and the two local lists diffed against main's, which names the difference module by module: the
 * editor's own 26, with `markdown-table-rows.ts` already on both sides and the dictation pair
 * already gone from both. 26 rather than 27 for exactly that reason — main reached the row splitter
 * first, so it is not this branch's to add twice.
 *
 * The 4,333 the merge is measured against is main's corrected reading, not the 4,332 it pinned at
 * `059ee59a48`: that census failed, `expected [ …(4333) ] to have a length of 4332`, because the
 * icon above joined beside the row splitter and was not counted. #22119 (`197550c952`) repinned
 * main to 4,333 with the paragraph above, and folding it here moves nothing — the icon was already
 * on both sides of the +26, so the pin below is this merge's own measurement, unchanged.
 *
 * Then #21705 (`eb92222e7f`) taught the agent option catalog Antigravity, and
 * `src/shared/agent-session-option-catalog-antigravity.ts` entered through the catalog the session
 * page already reaches. One module, string constants, no package; the one line that differs between
 * the closure at `841d06a969` and at `eb92222e7f`. It landed beside C2's merge, so main read one
 * short again.
 *
 *   modules        4359 -> 4360   (+1)
 *   local modules  1017 -> 1018   (+1)
 *
 * C8.1 then gave the HTML preview a capability to ask about, and three local modules join. Both
 * sides measured with `mobileWebAppRouteClosure(SESSION_ROUTE)` at base `841d06a969` with all five
 * postinstall generators run first, and the two `local` lists diffed rather than the total inferred:
 *
 *   modules        4359 -> 4362   (+3)
 *   local modules  1017 -> 1020   (+3)
 *
 * Named, and all three local: `src/components/use-html-preview-link-grant.web.ts`, the page's read
 * of `init.grants.native`; `src/components/html-preview-inert-links.ts`, the pass that turns the
 * artifact's links back into text without it; and
 * `src/mobile-web-shell/cancelled-navigation-target.ts`, which declares the grant token beside the
 * rule that acts on it and is reached both by that hook and by `page-route-policy.ts`. The
 * `bridge-caps.ts` it imports was already in this closure, and the hook's native sibling is
 * replaced rather than joined. Nothing vendored: three source modules, no package.
 *
 * The merge of the two is measured rather than summed, which is what this reading keeps having to
 * do. It agrees with the arithmetic this once, and only because the two additions are disjoint:
 * main's one module is the option catalog and this branch's three are the preview's, so neither
 * side counts the other's. Measured on the merged head with all five generators run first:
 *
 *   modules        4360 -> 4363   (+3, and 4359 -> 4363 from the shared base)
 *   local modules  1018 -> 1021   (+3)
 *
 * The C6.5 follow-up then aliased `zod` in the builder, so the four `src/shared` modules this route
 * reaches stop pulling the root's second copy in. The only reading here that has ever fallen: both
 * lists diffed, 94 gone and every one of them vendored `zod@4.5.4`, none added.
 *
 *   modules        4363 -> 4269   (-94)
 *   local modules  1021 -> 1021   (unchanged)
 *
 * The live-input seam then adds one: the two hooks that write the terminal's hidden field now go
 * through `src/terminal/terminal-live-input-text-write.ts`, and the page resolves its `.web.ts`.
 * One module, not two — the sibling replaces the native file, and both hooks were already here.
 *
 *   modules        4269 -> 4270   (+1)
 *   local modules  1021 -> 1022   (+1)
 *
 * The page's client identity joins beside it:
 * `src/mobile-web-shell/bridge/bridge-page-client-identity.ts` declares the placeholder
 * `client-context.web.tsx` claims, so the provider every screen reads imports it. One local module,
 * nothing vendored. Measured on this merged head rather than summed, all five generators run first:
 *
 *   modules        4270 -> 4271   (+1)
 *   local modules  1022 -> 1023   (+1)
 *
 * Cutting `expo-notifications` out of the page takes 62 vendored modules with it: 55 of its own,
 * and behind it expo-application 3, abort-controller 2, badgin 1, event-target-shim 1. The three
 * `.web` siblings replace their native files, so the local +1 is `host-app-version.ts` alone.
 *
 *   modules        4271 -> 4210   (-61)
 *   local modules  1023 -> 1024   (+1)
 *
 * The page's paint report joins beside that one, for the same reason:
 * `src/mobile-web-shell/bridge/bridge-page-painted.ts` holds the name the page posts and the name
 * it declares in `ready`, so `bridge-client-notifications.ts` — which every screen's client is
 * built from — imports it. One local module, nothing vendored; the seam that schedules the report
 * is the web entry's and does not enter a route closure. Re-measured on this merged head rather
 * than carried over from before the cut, with all five generators run first.
 *
 *   modules        4210 -> 4211   (+1)
 *   local modules  1024 -> 1025   (+1)
 *
 * The terminal fields' submit seam joins next, onto the 4,207 #22283 left, and both of its modules
 * are local. react-native-web withholds `onSubmitEditing` whenever the Enter keydown reports an
 * open composition, which is a soft keyboard's normal state mid-word, so both of the dock's fields
 * bind the browser's own line-break signal as well.
 * `src/terminal/use-terminal-text-field-submit-binding.ts` is the callback ref they take, and
 * `src/terminal/terminal-text-field-submit-binding.web.ts` is the binding it resolves to here; the
 * native sibling stays out of this closure, which is what the pair is for. Measured on this merged
 * head with all five generators run first, and the two joiners read off the closure list itself
 * rather than inferred from the delta.
 *
 *   modules        4207 -> 4209   (+2)
 *   local modules  1021 -> 1023   (+2)
 *
 * The page's claim on the device Back key joins beside those (#22300 landed first, so this is measured on the merged head). Two local
 * modules, nothing vendored, each named rather than left inside the total:
 * `src/navigation/use-back-claim.web.ts`, the seam every sheet and the handoff take, which enters
 * through `route-handoff.web.ts`; and `src/mobile-web-shell/bridge/bridge-page-back.ts`, the two
 * names the lane is negotiated under, which the envelope this route already reads imports.
 * `page-back-consumers.ts` is not a third: it hangs off `bridge-rpc-client.ts`, and no route
 * closure carries that — the page's client is built by the entry. Re-measured on the merged head
 * with all five generators run first.
 *
 *   modules        4209 -> 4211   (+2)
 *   local modules  1023 -> 1025   (+2)
 *
 * One joiner from outside `mobile/`: #22299 (9ece273056) added
 * `src/shared/agent-session-journal-producer.ts`, and three shared modules this route already
 * carries import it (`structured-agent-session-live-turn.ts`, `structured-agent-session-projection.ts`,
 * `native-chat-turn-activity.ts`). That PR changed no file under `mobile/`, so the mobile job never
 * ran and main landed one over this pin. Re-pinned here, on the head that merged it, by measuring
 * the closure on 9ece273056 against the previous head and diffing the two lists.
 *
 *   modules        4211 -> 4212   (+1)
 *   local modules  1025 -> 1026   (+1)
 *
 * The page's Retry decision joins after those: `src/transport/connection-retry-action.ts` says
 * whether a failed screen's Retry re-dials, re-reads or is not offered, and the session route
 * reaches it through the explorer, source control and git history it docks. One local module.
 *
 *   modules        4212 -> 4213   (+1)
 *   local modules  1026 -> 1027   (+1)
 *
 * Muse then joined the mobile agent catalog with its bundled icon, one more local input to the
 * shared agent picker.
 *
 *   modules        4213 -> 4214   (+1)
 *   local modules  1027 -> 1028   (+1)
 *
 * Muse's worker launch preferences then added `src/shared/agent-session-option-catalog-muse.ts`,
 * which the option catalog this route already reaches imports. One local module, measured.
 *
 *   modules        4214 -> 4215   (+1)
 *   local modules  1028 -> 1029   (+1)
 *
 * The structured tool line then added `src/shared/structured-agent-session-tool-call-block.ts`,
 * which the projection and live turn this route already reaches import. One local module,
 * measured; the change was src/shared-only, so its own CI never ran this suite.
 *
 *   modules        4215 -> 4216   (+1)
 *   local modules  1029 -> 1030   (+1)
 *
 * The page then took over its own safe area: the bridge client reaches
 * `bridge/bridge-safe-area-insets.ts`, and the closure gained the page's root layout
 * (`app/_layout.web.tsx`), which wraps every route. Two local modules, measured.
 *
 *   modules        4216 -> 4218   (+2)
 *   local modules  1030 -> 1032   (+2)
 *
 * Jcode joining the agent catalog then added `src/shared/agent-icons/jcode.png`, which
 * `mobile/src/components/mobile-agent-icon-assets.ts` requires alongside every other
 * agent icon. One local module, measured; an agent icon is a leaf asset, so it brings
 * nothing else with it.
 *
 * Re-measured on rebase: the count above had drifted two modules behind main before
 * this change, so the total moves by three while jcode itself accounts for one. The
 * closure was measured directly (`mobileWebAppRouteClosure`) rather than derived, and
 * `jcode.png` is the only local module this branch contributes.
 *
 *   modules        4218 -> 4221   (+3, of which jcode is +1)
 *   local modules  1032 -> 1035   (+3, of which jcode is +1)
 */
const SESSION_ROUTE_MODULES = 4221

/** What the page enters this route through once the route is a switch with a `.web.tsx` sibling. */
const ROUTE_ENTRY = [
  'app/h/[hostId]/session/[worktreeId].web.tsx',
  'src/session/MobileSessionRouteScreen.tsx',
  // Round 1's two, named for the reading above rather than left inside the total.
  'src/session/notification-pane-tab.ts',
  'src/mobile-web-shell/bridge/bridge-init-route.ts'
]

const artifactModules = (inputs) => inputs.filter((input) => input.includes(MERMAID_PAGE_ENGINE))
const packageModules = (inputs) => inputs.filter((input) => input.includes(MERMAID_PACKAGE))

const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

describeClosure(
  "the session route's page closure with the terminal on it",
  () => {
    it('gains the document, xterm and the addons, and sheds the engine string', async () => {
      const { local, modules } = await mobileWebAppRouteClosure(SESSION_ROUTE)
      for (const gone of SHED) {
        expect(local, `${gone} is still in the closure`).not.toContain(gone)
      }
      for (const gained of GAINED_OUTSIDE_THE_DOCUMENT) {
        expect(local, `${gained} is not in the closure`).toContain(gained)
      }
      for (const name of XTERM_PACKAGES) {
        expect(
          modules.some((module) => module.includes(`node_modules/${name}/`)),
          `${name} is not in the closure`
        ).toBe(true)
      }
      // The document, whole, and as modules: ruling 25 makes it ordinary TypeScript that the page
      // imports and calls, so the closure carries every module — including `message-bridge`, whose
      // two host facts are seams now — and nothing generated at all.
      const documentModules = local.filter((module) => module.startsWith('src/terminal/document/'))
      expect(documentModules).toContain('src/terminal/document/create-terminal-document.ts')
      expect(documentModules).toContain('src/terminal/document/message-bridge.ts')
      expect(documentModules.length).toBeGreaterThanOrEqual(36)
      // The bundle and its entry belong to the phone: a page reaching either would ship the
      // document twice, once as modules and once as a string.
      expect(documentModules).not.toContain('src/terminal/document/native-document-entry.ts')
      expect(local).not.toContain('src/terminal/terminal-webview-document-script.generated.ts')
    }, 300_000)

    it('enters through the web sibling and the route body, not the switch', async () => {
      const { local } = await mobileWebAppRouteClosure(SESSION_ROUTE)
      for (const entry of ROUTE_ENTRY) {
        expect(local, `${entry} is not in the closure`).toContain(entry)
      }
      // The switch itself is what the shell renders natively, and it reaches
      // `MobileWebShellScreen`, whose module calls `requireNativeViewManager` at import. A closure
      // that carried it would be a bundle that throws when the manifest imports this route.
      expect(local).not.toContain('app/h/[hostId]/session/[worktreeId].tsx')
      expect(local).not.toContain('src/mobile-web-shell/MobileWebShellScreen.tsx')
    }, 300_000)

    it('reaches the engine as one deferred module and never as part of the download', async () => {
      const { modules } = await mobileWebAppRouteClosure(SESSION_ROUTE)
      // The engine is here, as the one artifact the loader imports.
      expect(artifactModules(modules)).toHaveLength(1)
      // And the package's own file tree is not, anywhere: it is inside that artifact. Meaningful
      // only beside the line above, which is why the two sit together.
      expect(packageModules(modules)).toEqual([])
      expect(modules).toHaveLength(SESSION_ROUTE_MODULES)

      const download = await mobileWebAppRouteChunkClosure(SESSION_ROUTE)
      // The fence: nothing of the engine is reachable from the route's own chunk by an import
      // statement, so opening the session pays none of it.
      expect(artifactModules(download.staticInputs)).toEqual([])
      // The precondition that absence needs. The artifact is in the bundle, in a chunk the route
      // reaches by a `dynamic-import` edge instead -- a deferred engine, not a dropped one.
      expect(artifactModules(download.deferredInputs)).toHaveLength(1)
      // And the walk read a real download rather than one chunk: the route's own chunk is in it.
      expect(download.staticChunks).toContain(download.routeChunk)
      expect(download.staticInputs.length).toBeGreaterThan(1000)
    }, 600_000)

    it('leaves the 16px seam census exactly where C7.2 left it', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION_ROUTE)
      // Two preconditions, because zero offenders is what a walk that read nothing also reports:
      // the seam's own web module has to be in the closure, and no style may be unresolved.
      expect(closure.local).toContain('src/platform/text-input-font-size.web.ts')
      expect(unresolvedTextInputStyles(mobileDir, closure)).toEqual([])
      expect(textInputFontSizeOffenders(mobileDir, closure)).toHaveLength(EXPECTED_OFFENDERS)
    }, 300_000)

    it('holds the editables the TextInput census cannot see to the same floor', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION_ROUTE)
      // The rich Markdown editor's surface is a `contenteditable` in a markup string, sized by a
      // rule in a stylesheet: `modulesDeclaringTextInput` matches JSX tags and never sees it, so it
      // shipped at 14 px and was measured at 14 px in both engines. The same floor, read by a rule
      // that starts from the markup instead of from a prop.
      expect(editableHostsIn(mobileDir, closure)).toEqual([
        { file: 'src/components/rich-markdown/document-markup.ts', id: 'editor' }
      ])
      expect(unresolvedEditableHostStyles(mobileDir, closure)).toEqual([])
      expect(editableHostFontSizeOffenders(mobileDir, closure)).toEqual([])
    }, 300_000)
  },
  900_000
)
