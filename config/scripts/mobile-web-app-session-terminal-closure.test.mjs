import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { mobileWebAppRouteChunkClosure } from './mobile-web-app-route-chunk-closure.mjs'
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
  // The page's half of the stylesheet: the document-level rules are dropped and the rest is held
  // under the host, so what the page injects can only reach what the terminal owns.
  'src/terminal/terminal-webview-html/document-style-scoping.ts',
  'src/terminal/terminal-webview-ready-promises.ts',
  'src/terminal/use-terminal-webview-controller.ts'
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
 * Then ruling 36 gave the screen to the microphone and two local modules left:
 * `src/hooks/mobile-dictation-keep-awake.ts` and
 * `src/hooks/mobile-dictation-foreground-keep-awake.ts`, the page's wake-tag owner and its Android
 * foreground re-acquire. Both are deleted rather than moved — the device module that opens the
 * microphone takes the screen and gives it back — so the page has nothing left to own.
 *
 *   modules        4333 -> 4331   (-2)
 *   local modules   991 ->  989   (-2)
 *
 * Measured on this merge rather than subtracted from the line above, and the two local lists
 * diffed to name the difference: those two leave and nothing joins. The same measurement, taken
 * before #22067 landed, is how this branch read main's pin of 4,330 as three modules stale — the
 * three the paragraph above names.
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
 */
const SESSION_ROUTE_MODULES = 4333

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
  },
  900_000
)
