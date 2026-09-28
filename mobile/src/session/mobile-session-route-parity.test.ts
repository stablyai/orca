import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { MOBILE_SESSION_ROUTE_SOURCE_FILES } from './mobile-session-route-source-family.test-support'

const SESSION_FILES = MOBILE_SESSION_ROUTE_SOURCE_FILES
/** The function the route mounts, which C7.7 moved out of the route file and into a component. */
const ROOT_COMPONENT = 'MobileSessionRouteScreen'
const LOGIC_EXPANSION_NAMES = new Set([
  'useMobileSessionController',
  'useMobileSessionFoundation',
  'useMobileSessionScreenState',
  'useMobileSessionTerminalRuntime',
  'useMobileSessionFeedbackCapabilities',
  'useMobileSessionNativeChatDictation',
  'useMobileSessionTerminalSubscriptionFoundation',
  'useMobileSessionTerminalSubscription',
  'useMobileSessionTerminalStreamDisplay',
  'useMobileSessionTerminalList',
  'useMobileSessionTabApplication',
  'useMobileSessionDocumentReaders',
  'useMobileSessionDiffComments',
  'useMobileSessionMarkdownActions',
  'useMobileSessionTabReconciliation',
  'useMobileSessionLifecycle',
  'useMobileSessionKeyboardState',
  'useMobileSessionStartup',
  'useMobileSessionPreferenceFocus',
  'useMobileSessionTabSwitching',
  'useMobileSessionTerminalWebview',
  'useMobileSessionTerminalSendActions',
  'useMobileSessionFileActions',
  'useMobileSessionTerminalInput',
  'useMobileSessionAccessorySelection',
  'useMobileSessionAttachments',
  'useMobileSessionTerminalCreateActions',
  'useMobileSessionContentCreateActions',
  'useMobileSessionCloseActions',
  'useMobileSessionBulkClose',
  'useMobileSessionPresentation',
  'useMobileSessionPanelRouteActions'
])
const SURFACE_EXPANSION_NAMES = new Set([
  'MobileSessionSurface',
  'MobileSessionHeader',
  'MobileSessionContentRow',
  'MobileSessionActiveContent',
  'MobileSessionCommandDock',
  'MobileSessionSheets'
])
const CONTENT_COMPONENT_NAMES = ['MarkdownReader', 'DiffLineRow', 'FileReader'] as const
const HOST_COMPONENT_NAMES = new Set([
  'ActivityIndicator',
  'Animated.View',
  'FlatList',
  'Image',
  'Pressable',
  'SafeAreaView',
  'ScrollView',
  'Text',
  'TextInput',
  'View'
])

// Refreshed by C7.2: five clipboard hooks joined the expanded route, which is the whole of the +5 —
// a writer in the diff-note, Markdown and selection actions, a reader in the selection actions and
// the attachment probe. The screen's other four clipboard sites (the terminal's paste, the sheets,
// the quick-command row, the diff-review send) sit outside the walk from `MobileSessionRouteScreen`
// and so do not move this pin. The copy-path sheet also gained the failure toast the other two had.
// Refreshed for `reportDictationFailure`, the whole of that +1: the composer's two dictation
// failure handlers were one policy written twice, and only `onError`'s copy knew about the setup
// sheet, so a refused start showed the desktop's own `voice_dictation_disabled` as a toast.
//
// Refreshed again for the page's keyboard: the screen's own `Keyboard.addListener` pair became the
// `useSoftKeyboard` seam, because react-native-web never fires those events and the live input row
// laid itself out under the IME. +2 hooks (the seam, and the one effect split into a visibility one
// and a height one), +1 effect, -2 registrations and -2 removals for the listener pair, and -6
// strings: the four event names and the two `'ios'` guards that chose between them. Re-recorded
// against the merged tree, since neither side's hash covers the other's change.
//
// Refreshed for the terminal fields' submit seam: react-native-web withholds `onSubmitEditing`
// when the Enter keydown reports an open composition, which is a soft keyboard's normal mid-word
// state, so both of the dock's fields also bind the page's own line-break signal. +4 hooks and +2
// callbacks in the send actions — `submitLiveInput` and `submitBufferedDraft`, each with a
// `useTerminalTextFieldSubmitBinding` beside it — and both fields moved their ref, the live one
// its submit handler too.
// Moved once more, -1 hook and -1 callback: `submitBufferedDraft` stopped being a `useCallback`.
// Memoizing it on `[]` froze the per-render `handleSend` it reads, whose guard needs a `client`
// and an `activeHandle` the first render does not have, so the page's line-break submit could
// never pass it. Found by pullfrog on #22300.
// Moved, count unchanged, when the Markdown actions' Back `useEffect` became `useBackClaim`, the
// seam that also claims the key on the page while a draft is dirty.
// Refreshed when the first subscribe began sizing itself from the document's reported cell box:
// the first-subscribe mark ref and `measureViewportOnce` are gone (hooks 282 → 280, callbacks 79 → 78).
// Again when xterm became the only cell measurer: `useTerminalCellBoxRefit` is gone, the frame's
// width ref and `handleTerminalFrameLayout` subscribe a known box on layout (hooks 282, callbacks 79),
// and the pane's `onCellBoxChange` goes to the viewport refit.
// Again when one frame ref replaced the height ref, width ref and width state (hooks 280).
// Again when one `notifyTerminalFrame` took the frame's layout (hooks 281, callbacks 80).
const HEAD_MAIN_HOOK_SHA256 = '004b011722b17ac82c96f0b3c8e303d39b2431a216424e9b86a1ee6a4896f23e'
// Moved when the prompt-cancel flag became one structured-session host support object (main).
// Re-recorded against the merged tree. Again when the frame-layout and cell-box-change callbacks
// named the refs they read in their dependency lists (react-doctor).
// Again when the frame's width and height became one `terminalFrameRef`.
// Again when the frame's layout moved into `notifyTerminalFrame`.
const HEAD_HOOK_BINDING_SHA256 = 'c1bcb859202aaf8d612d3023cb4d895719da513879c61b01545a249a0bda662b'
// Moved when `notifyTerminalFrame` joined and `handleTerminalFrameLayout` became `subscribeIntendedActiveTerminal`.
const HEAD_CALLBACK_IDENTITY_SHA256 =
  '9c966301b373c11b27359ef1388c593b638c7f6831186d5c5321553504183e07'
// Pins that no callback body in the route changed unnoticed. Body text, not behaviour: the sends
// and repo reads inside them now name their `RpcOperation` instead of the raw `sendRequest` port.
// Refreshed in step 6 for the gesture flush, whose `terminal.send` became `terminalInputSend` and
// whose accepted-check became that operation's own verdict, then again when that check was spelled
// `=== true` to match the other four sites reading the same verdict. Refreshed in step 7 for the
// reply casts the checked readers made unnecessary — the markdown tab doc, the worktree record's
// `diffComments` and the browser tab's page id are typed by their schemas now. Refreshed once more
// on the merge, for the display-mode toggle whose send became `terminalDisplayModeSet`. Refreshed
// for the files domain's step 7, which retired the markdown disk fallback's `{ content, truncated,
// byteLength }` cast: the preview reader checks the content and salvages the flag, so `readMarkdownTab`
// reads `fallback.value` directly. The dictation-mode refresh is main's own body again — it forwards
// whatever mode the reply carried, so an absent one leaves the mic as inert as main left it.
// Refreshed on the merge of C7.2 and C7.3, which moved this pin from both sides: the terminal
// subscribe now carries the snapshot byte budget its transport imposes, nothing on a phone and the
// frame cap inside the shell's page, and the Markdown copy action gained the failure branch that
// answers a refused write. Re-recorded against the merged tree, since neither side's hash covers
// the other's body. The hook and string counts are C7.2's and stand.
// Refreshed once more for the two dictation failure handlers, which now both call
// `reportDictationFailure` instead of each choosing between the setup sheet and a toast.
// Moved when the metrics handler compared every field, the row pitch included (main).
// Again when the subscribe waited for web-ready and `handleTerminalWebReady` lost `documentHasInit`.
// Again when the subscribe's inits began carrying the laid-out terminal frame, and its resize too.
// Again when those grids read the one frame ref.
// Again when the subscribe sized its viewport inline instead of through a helper.
// Again when the document took the hold rule and the subscribe stopped holding its grid.
// Again when an init took one options object.
// Again when the frame's layout became one `notifyTerminalFrame`.
// Again when the init option took the message's name, `initialData`.
const HEAD_CALLBACK_BODY_SHA256 = '4848e925f478f1656f26031c1bdebbb9f2da60811c7e91cfd732fc9da9764079'
// Refreshed for the startup effect: both `worktree.activate` sends became `worktreeActivate`, and
// the sleeping-agent check reads that operation's verdict instead of the reply envelope. Refreshed
// again when the reporter took the reply and interpreted it itself, retiring the hand-built
// refusal the timer site passed when it had no reply at all. Refreshed once more for the
// last-visited-worktree effect, whose bare store write became the one writer of that key, so the
// hybrid shell's page mirror sees it as it is written rather than one `init` later. Refreshed for
// the diff-comments effect, which now catches the loader's rejection. Count unchanged.
// Moved again by the keyboard seam above, which is the +1 effect.
// -1 effect for the Markdown actions' Back registration, which is `useBackClaim`'s own now.
// Moved by the capability probe setting that host support object.
const HEAD_EFFECT_SHA256 = '9b045a547ed269acf95db16cc87e33a9035a20c6888fd30e0363e58bb6b7d883'
const HEAD_CONTENT_HOOK_SHA256 = '9c3b612fef3f370d66873aefdbe1d701f20cb64ded31fef5cc45fde6f8189581'
// Same pin for the 12 bodies that sit in nested functions rather than callbacks, moved by the same
// rewrite of those send and read expressions. Count unchanged. Refreshed again in step 6 for
// `handleClearTerminal`, whose send became `terminalBufferClear`, in step 7 for the browser tab
// create, whose `{ browserPageId?: string }` cast its schema now carries, and once more for
// `handleCreateTerminal`, whose send became `sessionTabCreateTerminal` and whose `response.ok`
// branch became that operation's own throw-the-host-message acceptance. Refreshed for negotiated
// optimistic placement, which defers to legacy host snapshots when ownership paths disagree.
const HEAD_NESTED_FUNCTION_SHA256 =
  '923b5ea7fe3330cbd98213b72736bf1f653115ddb5492cb8eb8306d8ca4f28e8'
// -1 registration and -1 removal: the Markdown actions' `BackHandler` pair is `useBackClaim`'s.
const HEAD_NATIVE_REGISTRATION_SHA256 =
  '87d4599f475575131d4d5daa20f0dac579ca6c829353cbb654206ea6965dadae'
const HEAD_NATIVE_REMOVAL_SHA256 =
  '089bebbc1e4f2e68c5dbaf189bb605d8d5bb247ef5ca52b9db08cc2661afc097'
const HEAD_TIMER_CREATION_SHA256 =
  '1a31b625e2174c3db77272249843196d2b6b06ab1e654a96d8f7858e3082e66b'
const HEAD_TIMER_CLEANUP_SHA256 = 'c73f1d1c2cc89642f3d727d6f3b6b81860a9d6f34234541a2065ec3d1a8cd116'
// Six method literals fewer than before step 6: `terminal.send` and `terminal.clearBuffer` went
// first, then `worktree.activate` twice, `session.tabs.createTerminal` and
// `terminal.setDisplayMode`. Each is now fixed at its operation's definition instead of being
// spelled at the call site. Two literals more across C7.2, both of them the toast a refused write
// now shows: "Couldn't copy path" when the sheets moved onto the clipboard seam, taking the count
// from 532 to 533, and "Couldn't copy" when the Markdown copy action gained the failure branch the
// other copy paths already had, taking it to 534.
//
// Two more across C7.7, 534 -> 536: `'web'`, the platform guard the Markdown actions'
// `BackHandler` registration gained so it stops logging on the page, and `"button"`, the
// accessibility role the header's Back control gained so the page serves it by name. Neither is a
// behaviour change on a phone. The same `'web'` moves the effect hash, and `"button"` the host-JSX
// hash. The effect hash moved a second time and back: the diff-notes loader's uncaught rejection
// was caught and then reverted, because the fix moves `matrix-session.diff-notes-worktree.show-1`
// and a golden is a review event — so this hash is the one the uncaught `void` call produces.
//
// 536 -> 530 for the keyboard seam above: the four event names and the two `'ios'` guards left
// with the listener pair.
//
// The host-JSX hash moved for the header's reconnect tap, which now also checks the re-dial exists:
// the page's provider hands out none. Nothing a phone renders or does changed.
//
// 530 -> 529: `'hardwareBackPress'` left with the Markdown actions' registration for `useBackClaim`.
//
// 529 -> 530, and the host-JSX hash: `key="terminal-frame"`, so the page's frame mounts with its
// onLayout rather than reusing the loading View. Native measured 47 rows before and after: its
// frame reported either way, and its window is its frame, so both measure paths agree there.
//
// 531 -> 530, and the host-JSX and style hashes: the key left, and one `contentFrame` View wraps
// every branch and carries the frame's onLayout, so the page's frame mounts with it. The page measured
// 47 rows before and after; native was measured only on main's bundle (47), and the wrapper is a
// flex:1 View around the same flex:1 frame, so its box is the frame's.
// Count unchanged: `'frame-not-laid-out'`, the gate awaiting the frame's first layout, replaced `'measuring-viewport'`.
const HEAD_RUNTIME_STRING_SHA256 =
  '83ae65d5c5ae056504f4d08bb4aa524b42d82f70d8e44035ccdd6a2d9021a387'
// Moved by both of the dock's fields: their refs, and the live one's submit handler, are the seam's now.
// Moved again when the terminal frame kept its laid-out width unrounded, for every fit.
// Again when the frame's onLayout wrote one frame ref and notified a new width imperatively.
// Again when the frame's first laid-out layout alone subscribes a held-back document.
// Again when the frame's onLayout made one `notifyTerminalFrame` call.
const HEAD_HOST_JSX_SHA256 = '8ab32926fff2e610ab92bde8437283a11ad2328c6343cd862a1c00b2ed8ed5a6'
const HEAD_LEAF_JSX_SHA256 = '62eb05c6e2ac0be6d553a141fc8aa1641fcb0c678777d5d539f490aab8648417'
const HEAD_STYLE_REFERENCE_SHA256 =
  '56a005a1f65b30c11092e3422caef67810e1ec50f66fdd06471c370138b1eeb6'
const HEAD_IDENTITY_FIELD_SHA256 =
  '91146853930a34dd1f3d80e5c97fbacd7cf19fb93dd26fe8fc6f29169622f9d6'
const HEAD_NAVIGATION_SHA256 = '9d96f5dad7de555d6553eac39c0fab00efad507470fd562cb9beaa32db16f512'
// Moved when structured-session features became one helper call; the capability strings it reads
// are pinned by that helper's own test.
const HEAD_CAPABILITY_SHA256 = 'ec1159d6e726383bf7121e9c642657fee5b4ebec049cb44ba132a303bb9a61e2'

type Definition = { declaration: ts.FunctionDeclaration; sourceFile: ts.SourceFile }
type HookFacts = {
  bindings: string[]
  callbackBodies: string[]
  callbacks: string[]
  effects: string[]
  hooks: string[]
}

const printer = ts.createPrinter({ removeComments: true })
const sourceFiles = new Map<string, ts.SourceFile>()

function parse(relativePath: string): ts.SourceFile {
  const cached = sourceFiles.get(relativePath)
  if (cached) {
    return cached
  }
  const filePath = fileURLToPath(new URL(relativePath, import.meta.url))
  const sourceFile = ts.createSourceFile(
    relativePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  sourceFiles.set(relativePath, sourceFile)
  return sourceFile
}

function canonical(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, '')
}

function hash(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\n')).digest('hex')
}

function readDefinitions(): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  for (const relativePath of SESSION_FILES) {
    const sourceFile = parse(relativePath)
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        definitions.set(node.name.text, { declaration: node, sourceFile })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

function visitLogicalFunction(
  name: string,
  definitions: ReadonlyMap<string, Definition>,
  onNode: (node: ts.Node, sourceFile: ts.SourceFile) => void,
  active = new Set<string>()
): void {
  const definition = definitions.get(name)
  if (!definition?.declaration.body) {
    throw new Error(`Missing session function: ${name}`)
  }
  if (active.has(name)) {
    throw new Error(`Recursive session function: ${name}`)
  }
  const nextActive = new Set(active).add(name)
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      LOGIC_EXPANSION_NAMES.has(node.expression.text)
    ) {
      visitLogicalFunction(node.expression.text, definitions, onNode, nextActive)
      return
    }
    onNode(node, definition.sourceFile)
    ts.forEachChild(node, visit)
  }
  visit(definition.declaration.body)
}

function readHookFacts(name: string, definitions: ReadonlyMap<string, Definition>): HookFacts {
  const facts: HookFacts = {
    bindings: [],
    callbackBodies: [],
    callbacks: [],
    effects: [],
    hooks: []
  }
  visitLogicalFunction(name, definitions, (node, sourceFile) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !/^use[A-Z]/.test(node.expression.text)
    ) {
      return
    }
    const hookName = node.expression.text
    facts.hooks.push(hookName)
    const owner = ts.isVariableDeclaration(node.parent)
      ? node.parent.name.getText(sourceFile)
      : ts.isExpressionStatement(node.parent)
        ? '<statement>'
        : ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression)
          ? `<argument:${node.parent.expression.text}>`
          : '<nested>'
    const lastArgument = node.arguments.at(-1)
    const dependencies =
      lastArgument && ts.isArrayLiteralExpression(lastArgument)
        ? canonical(lastArgument, sourceFile)
        : '<none>'
    facts.bindings.push(`${hookName}|${owner}|${dependencies}`)
    if (hookName === 'useCallback') {
      facts.callbacks.push(`${owner}|${dependencies}`)
      facts.callbackBodies.push(
        `${owner}|${canonical(node.arguments[0], sourceFile)}|${dependencies}`
      )
    }
    if (hookName === 'useEffect') {
      facts.effects.push(`${canonical(node.arguments[0], sourceFile)}|${dependencies}`)
    }
  })
  return facts
}

function readNestedFunctions(definitions: ReadonlyMap<string, Definition>): string[] {
  const functions: string[] = []
  const visitDefinition = (name: string, active: ReadonlySet<string>): void => {
    const definition = definitions.get(name)
    if (!definition?.declaration.body || active.has(name)) {
      throw new Error(`Invalid nested-function stage: ${name}`)
    }
    const nextActive = new Set(active).add(name)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        LOGIC_EXPANSION_NAMES.has(node.expression.text)
      ) {
        visitDefinition(node.expression.text, nextActive)
        return
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        functions.push(`${node.name.text}|${canonical(node, definition.sourceFile)}`)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(definition.declaration.body)
  }
  visitDefinition(ROOT_COMPONENT, new Set())
  return functions
}

function readNativeAndTimerFacts(definitions: ReadonlyMap<string, Definition>): {
  cleanups: string[]
  creations: string[]
  registrations: string[]
  removals: string[]
} {
  const registrations: string[] = []
  const removals: string[] = []
  const creations: string[] = []
  const cleanups: string[] = []
  const collect = (node: ts.Node, sourceFile: ts.SourceFile): void => {
    if (!ts.isCallExpression(node)) {
      return
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(sourceFile)
      const method = node.expression.name.text
      if (
        ['BackHandler', 'AppState', 'Keyboard'].includes(receiver) &&
        ['addEventListener', 'addListener'].includes(method)
      ) {
        registrations.push(canonical(node, sourceFile))
      }
      if (method === 'remove') {
        removals.push(canonical(node, sourceFile))
      }
    }
    if (ts.isIdentifier(node.expression)) {
      if (['setTimeout', 'setInterval', 'requestAnimationFrame'].includes(node.expression.text)) {
        creations.push(canonical(node, sourceFile))
      }
      if (
        ['clearTimeout', 'clearInterval', 'cancelAnimationFrame'].includes(node.expression.text)
      ) {
        cleanups.push(canonical(node, sourceFile))
      }
    }
  }
  visitLogicalFunction('FileReader', definitions, collect)
  visitLogicalFunction(ROOT_COMPONENT, definitions, collect)
  return { cleanups, creations, registrations, removals }
}

function isRuntimeNode(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isImportTypeNode(parent) ||
      ts.isTypeNode(parent)
    ) {
      return false
    }
  }
  return true
}

function readRuntimeStrings(): string[] {
  const values: string[] = []
  for (const relativePath of SESSION_FILES) {
    const visit = (node: ts.Node): void => {
      if (isRuntimeNode(node)) {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          values.push(node.text)
        }
        if (ts.isJsxText(node) && node.text.trim()) {
          values.push(node.text.replace(/\s+/g, ' ').trim())
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(relativePath))
  }
  return values.sort()
}

function readJsxFacts(definitions: ReadonlyMap<string, Definition>): {
  host: string[]
  leaf: string[]
  styleReferences: string[]
} {
  const host: string[] = []
  const leaf: string[] = []
  const active = new Set<string>()
  const visitDefinition = (name: string): void => {
    const definition = definitions.get(name)
    if (!definition?.declaration.body || active.has(name)) {
      throw new Error(`Invalid JSX stage: ${name}`)
    }
    active.add(name)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        LOGIC_EXPANSION_NAMES.has(node.expression.text)
      ) {
        visitDefinition(node.expression.text)
        return
      }
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node
        const tagName = opening.tagName.getText(definition.sourceFile)
        if (SURFACE_EXPANSION_NAMES.has(tagName)) {
          visitDefinition(tagName)
          return
        }
        const attributes = opening.attributes.properties
          .map((attribute) => {
            if (ts.isJsxSpreadAttribute(attribute)) {
              return `...${canonical(attribute.expression, definition.sourceFile)}`
            }
            const attributeName = attribute.name.getText(definition.sourceFile)
            if (!attribute.initializer) {
              return attributeName
            }
            if (ts.isStringLiteral(attribute.initializer)) {
              return `${attributeName}=${JSON.stringify(attribute.initializer.text)}`
            }
            return `${attributeName}=${
              attribute.initializer.expression
                ? canonical(attribute.initializer.expression, definition.sourceFile)
                : ''
            }`
          })
          .join(',')
        ;(HOST_COMPONENT_NAMES.has(tagName) ? host : leaf).push(`${tagName}|${attributes}`)
        for (const attribute of opening.attributes.properties) {
          ts.forEachChild(attribute, visit)
        }
        if (ts.isJsxElement(node)) {
          for (const child of node.children) {
            visit(child)
          }
        }
        return
      }
      if (ts.isJsxFragment(node)) {
        for (const child of node.children) {
          visit(child)
        }
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(definition.declaration.body)
    active.delete(name)
  }
  for (const name of CONTENT_COMPONENT_NAMES) {
    visitDefinition(name)
  }
  visitDefinition(ROOT_COMPONENT)
  const styleReferences: string[] = []
  for (const record of [...host, ...leaf]) {
    for (const match of record.matchAll(/styles\.([A-Za-z0-9_]+)/g)) {
      styleReferences.push(match[1])
    }
  }
  return { host, leaf, styleReferences }
}

function readCompatibilityFacts(definitions: ReadonlyMap<string, Definition>): {
  capabilities: string[]
  identityFields: string[]
  navigation: string[]
} {
  const capabilities: string[] = []
  const identityFields: string[] = []
  const navigation: string[] = []
  visitLogicalFunction(ROOT_COMPONENT, definitions, (node, sourceFile) => {
    if (!isRuntimeNode(node)) {
      return
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile)
      if (['notifyClients', 'deviceToken', 'clientId'].includes(name)) {
        identityFields.push(`${name}|${canonical(node.initializer, sourceFile)}`)
      }
      if (
        name === 'client' &&
        ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.some(
          (property) => property.name?.getText(sourceFile) === 'id'
        ) &&
        node.initializer.properties.some(
          (property) => property.name?.getText(sourceFile) === 'type'
        )
      ) {
        identityFields.push(`client|${canonical(node.initializer, sourceFile)}`)
      }
    }
    if (!ts.isCallExpression(node)) {
      return
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === 'router' &&
      ['push', 'replace', 'back'].includes(node.expression.name.text)
    ) {
      navigation.push(canonical(node, sourceFile))
    }
    const callName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ''
    const callText = canonical(node, sourceFile)
    if (
      [
        'startRuntimeCapabilityProbe',
        'supportsMobileQuickCommands',
        'structuredAgentSessionHostSupport'
      ].includes(callName) ||
      (callName === 'includes' && callText.includes('capabilities.includes'))
    ) {
      capabilities.push(callText)
    }
  })
  return { capabilities, identityFields, navigation }
}

describe('mobile session route extraction parity', () => {
  it('preserves hooks, callbacks, effects, and nested action bodies', () => {
    const definitions = readDefinitions()
    const main = readHookFacts(ROOT_COMPONENT, definitions)
    const contentBindings = CONTENT_COMPONENT_NAMES.flatMap(
      (name) => readHookFacts(name, definitions).bindings
    )
    expect(main.hooks).toHaveLength(281)
    expect(hash(main.hooks)).toBe(HEAD_MAIN_HOOK_SHA256)
    expect(hash(main.bindings)).toBe(HEAD_HOOK_BINDING_SHA256)
    expect(main.callbacks).toHaveLength(80)
    expect(hash(main.callbacks)).toBe(HEAD_CALLBACK_IDENTITY_SHA256)
    expect(hash(main.callbackBodies)).toBe(HEAD_CALLBACK_BODY_SHA256)
    expect(main.effects).toHaveLength(24)
    expect(hash(main.effects)).toBe(HEAD_EFFECT_SHA256)
    expect(contentBindings).toHaveLength(14)
    expect(hash(contentBindings)).toBe(HEAD_CONTENT_HOOK_SHA256)
    const nestedFunctions = readNestedFunctions(definitions)
    expect(nestedFunctions).toHaveLength(12)
    expect(hash(nestedFunctions)).toBe(HEAD_NESTED_FUNCTION_SHA256)
  })

  it('preserves native listeners, timers, identity payloads, and compatibility gates', () => {
    const definitions = readDefinitions()
    const native = readNativeAndTimerFacts(definitions)
    expect(native.registrations).toHaveLength(4)
    expect(hash(native.registrations)).toBe(HEAD_NATIVE_REGISTRATION_SHA256)
    expect(native.removals).toHaveLength(6)
    expect(hash(native.removals)).toBe(HEAD_NATIVE_REMOVAL_SHA256)
    expect(native.creations.filter((fact) => fact.startsWith('setTimeout'))).toHaveLength(7)
    expect(native.creations.filter((fact) => fact.startsWith('setInterval'))).toHaveLength(1)
    expect(
      native.creations.filter((fact) => fact.startsWith('requestAnimationFrame'))
    ).toHaveLength(1)
    expect(hash(native.creations)).toBe(HEAD_TIMER_CREATION_SHA256)
    expect(native.cleanups.filter((fact) => fact.startsWith('clearTimeout'))).toHaveLength(11)
    expect(native.cleanups.filter((fact) => fact.startsWith('clearInterval'))).toHaveLength(1)
    expect(native.cleanups.filter((fact) => fact.startsWith('cancelAnimationFrame'))).toHaveLength(
      1
    )
    expect(hash(native.cleanups)).toBe(HEAD_TIMER_CLEANUP_SHA256)
    const compatibility = readCompatibilityFacts(definitions)
    expect(compatibility.identityFields).toHaveLength(14)
    expect(hash(compatibility.identityFields)).toBe(HEAD_IDENTITY_FIELD_SHA256)
    expect(compatibility.navigation).toHaveLength(6)
    expect(hash(compatibility.navigation)).toBe(HEAD_NAVIGATION_SHA256)
    expect(compatibility.capabilities).toHaveLength(6)
    expect(hash(compatibility.capabilities)).toBe(HEAD_CAPABILITY_SHA256)
  })

  it('preserves runtime strings, styles, and the expanded JSX tree', () => {
    const strings = readRuntimeStrings()
    expect(strings).toHaveLength(530)
    expect(hash(strings)).toBe(HEAD_RUNTIME_STRING_SHA256)
    const jsx = readJsxFacts(readDefinitions())
    expect(jsx.host).toHaveLength(125)
    expect(hash(jsx.host)).toBe(HEAD_HOST_JSX_SHA256)
    expect(jsx.leaf).toHaveLength(61)
    expect(hash(jsx.leaf)).toBe(HEAD_LEAF_JSX_SHA256)
    expect(jsx.styleReferences).toHaveLength(173)
    expect(hash(jsx.styleReferences)).toBe(HEAD_STYLE_REFERENCE_SHA256)
  })
})
