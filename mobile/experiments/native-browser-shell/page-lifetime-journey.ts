import { Linking } from 'react-native'
import { reloadAppAsync, requireNativeModule } from 'expo-modules-core'
import * as FileSystem from 'expo-file-system/legacy'
import {
  openNativeBrowserFixture,
  nativeBrowserCommand,
  closeNativeBrowser,
  resumeNativeBrowser,
  type NativeBrowserPage
} from '../../modules/orca-mobile-web-shell/src/native-browser'

const route = {
  authorityId: 'fixture-authority',
  executionHostId: 'ssh:fixture',
  orcaProfileId: 'orca-fixture',
  browserProfileId: 'browser-fixture',
  proxyUrl: 'http://127.0.0.1:18779'
}
const stateFile = `${FileSystem.documentDirectory}page-lifetime.json`
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const native = requireNativeModule<{
  browserFixtureState(): Promise<string>
  terminateBrowserFixture(generation: string): Promise<string>
}>('OrcaMobileWebShell')

export async function record(name: string, value: unknown) {
  const response = await fetch(`http://10.0.2.2:18779/evidence/${name}`, {
    method: 'POST',
    body: JSON.stringify(value)
  })
  if (!response.ok) {
    throw new Error(`Evidence refused: ${name}`)
  }
}
function assert(value: unknown, reason: string): asserts value {
  if (!value) {
    throw new Error(reason)
  }
}
async function rejects(action: () => Promise<unknown>, reason: string) {
  try {
    await action()
  } catch (error) {
    assert(String(error).includes(reason), String(error))
    return String(error)
  }
  throw new Error(`Expected rejection: ${reason}`)
}
async function shell(focused: boolean) {
  const value: unknown = JSON.parse(await native.browserFixtureState())
  assert(
    typeof value === 'object' &&
      value !== null &&
      'moduleId' in value &&
      typeof value.moduleId === 'string' &&
      'shellFocused' in value &&
      value.shellFocused === focused,
    `Unexpected shell focus: ${JSON.stringify(value)}`
  )
  return value
}
async function evaluate(page: NativeBrowserPage, expression: string): Promise<unknown> {
  const value = await nativeBrowserCommand(page, { operation: 'evaluate', params: { expression } })
  assert(
    typeof value === 'object' &&
      value !== null &&
      'result' in value &&
      typeof value.result === 'object' &&
      value.result !== null &&
      'value' in value.result,
    `Missing evaluation value: ${JSON.stringify(value)}`
  )
  return value.result.value
}
async function capture(page: NativeBrowserPage, name: string, expected: unknown) {
  assert((await evaluate(page, contents)) === expected, 'Capture document changed')
  const png = await nativeBrowserCommand(page, { operation: 'screenshot' })
  assert(
    typeof png === 'object' &&
      png !== null &&
      'captureKind' in png &&
      png.captureKind === 'software-viewport' &&
      'width' in png &&
      png.width === 640 &&
      'height' in png &&
      png.height === 960 &&
      'generation' in png &&
      png.generation === page.generation,
    `Unexpected capture: ${JSON.stringify(png)}`
  )
  assert(
    (await evaluate(page, 'innerWidth + "x" + innerHeight')) === '640x960',
    'Unexpected CSS viewport'
  )
  assert((await evaluate(page, contents)) === expected, 'Capture changed the document')
  await record(name, png)
}
async function navigate(page: NativeBrowserPage) {
  await nativeBrowserCommand(page, {
    operation: 'navigate',
    params: { url: 'http://fixture.invalid/page' }
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await evaluate(page, 'document.title')) === 'Guest fixture') {
      return
    }
    await delay(100)
  }
  throw new Error('Guest did not navigate through proxy')
}
function pageFrom(value: unknown): NativeBrowserPage {
  assert(
    typeof value === 'object' &&
      value !== null &&
      'generation' in value &&
      typeof value.generation === 'string' &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      'profile' in value &&
      typeof value.profile === 'string',
    'Invalid saved page'
  )
  return { generation: value.generation, pid: value.pid, profile: value.profile }
}
const contents =
  'JSON.stringify({nonce:window.nonce,value:document.querySelector("input").value,output:document.querySelector("output").textContent,stored:localStorage.getItem("customer"),trusted:window.trusted,submitted:window.submitted})'

export async function runJourney(shellMessages: () => number) {
  try {
    const saved = await FileSystem.getInfoAsync(stateFile)
    if (saved.exists) {
      const state: unknown = JSON.parse(await FileSystem.readAsStringAsync(stateFile))
      assert(
        typeof state === 'object' &&
          state !== null &&
          'page' in state &&
          'moduleId' in state &&
          'contents' in state,
        'Invalid reload checkpoint'
      )
      const page = pageFrom(state.page)
      const reloaded = await shell(true)
      assert(reloaded.moduleId !== state.moduleId, 'React module was not replaced')
      await rejects(
        () => openNativeBrowserFixture({ ...route, browserProfileId: 'replacement' }),
        'guest_process_occupied'
      )
      assert((await evaluate(page, contents)) === state.contents, 'Reload changed the document')
      await delay(300)
      assert(
        (await evaluate(page, contents)) === state.contents,
        'Old module teardown destroyed the document'
      )
      await record('reload', { reloaded, page, contents: state.contents })
      await capture(page, 'screenshot', state.contents)
      await record(
        'evalException',
        await rejects(() => evaluate(page, 'throw new Error("fixture")'), 'evaluation_exception')
      )
      await closeNativeBrowser(page)
      await record('closed', true)
      const second = await openNativeBrowserFixture(route)
      assert(
        second.pid !== page.pid &&
          second.generation !== page.generation &&
          second.profile === page.profile,
        'Reopen identity failed'
      )
      await navigate(second)
      const storage = await evaluate(second, 'localStorage.getItem("customer")')
      assert(storage === 'Orca native 한글 ✓', 'Process reopen lost storage')
      const reopenedNonce = await evaluate(second, 'window.nonce')
      await resumeNativeBrowser(second)
      await delay(150)
      assert(
        (await evaluate(second, 'window.nonce')) === reopenedNonce,
        'Reopened presentation replaced the page'
      )
      await Linking.openURL('orca://fixture')
      await delay(300)
      await record('storage', { second, storage, shell: await shell(true) })
      await record(
        'stale',
        await rejects(
          () => nativeBrowserCommand(page, { operation: 'accessibility' }),
          'stale_guest_generation'
        )
      )
      const pending = rejects(() => evaluate(second, 'while(true){}'), 'guest_process_exited')
      await delay(200)
      await native.terminateBrowserFixture(second.generation)
      await record('death', await pending)
      const third = await openNativeBrowserFixture({ ...route, executionHostId: 'wsl:fixture' })
      assert(third.profile !== second.profile, 'Execution hosts share a profile')
      await navigate(third)
      assert(
        (await evaluate(third, 'localStorage.getItem("customer")')) === null,
        'Execution hosts share storage'
      )
      await record('isolated', third)
      await closeNativeBrowser(third)
      const before = shellMessages()
      await delay(400)
      assert(shellMessages() > before, 'OTA shell stopped responding')
      await record('passed', { shellMessages: shellMessages(), shell: await shell(true) })
      await FileSystem.deleteAsync(stateFile)
      return
    }
    const page = await openNativeBrowserFixture(route)
    const initial = await shell(true)
    await record('opened', { page, shell: await shell(true) })
    await rejects(() => openNativeBrowserFixture(route), 'guest_process_occupied')
    await navigate(page)
    const ax = await nativeBrowserCommand(page, { operation: 'accessibility' })
    assert(
      JSON.stringify(ax).includes('Customer') && JSON.stringify(ax).includes('textbox'),
      'AX lacks form semantics'
    )
    await record('ax', ax)
    await nativeBrowserCommand(page, { operation: 'click', params: { x: 90, y: 80 } })
    await nativeBrowserCommand(page, {
      operation: 'insertText',
      params: { text: 'Orca native 한글' }
    })
    await nativeBrowserCommand(page, { operation: 'click', params: { x: 75, y: 150 } })
    let entered = await evaluate(page, contents)
    assert(
      typeof entered === 'string' &&
        entered.includes('Saved Orca native 한글') &&
        entered.includes('"trusted":true') &&
        entered.includes('"submitted":true'),
      `Form failed: ${entered}`
    )
    await record('input', entered)
    await capture(page, 'backgroundScreenshot', entered)
    await record('background', { shell: await shell(true), entered })
    await resumeNativeBrowser(page)
    await delay(300)
    assert((await evaluate(page, contents)) === entered, 'Presentation replaced the page')
    await record('presented', { shell: await shell(false), entered })
    await Linking.openURL('orca://fixture')
    await delay(500)
    assert((await evaluate(page, contents)) === entered, 'Return lost page state')
    await nativeBrowserCommand(page, { operation: 'click', params: { x: 245, y: 80 } })
    await nativeBrowserCommand(page, { operation: 'insertText', params: { text: ' ✓' } })
    await nativeBrowserCommand(page, { operation: 'click', params: { x: 75, y: 150 } })
    entered = await evaluate(page, contents)
    assert(
      typeof entered === 'string' && entered.includes('Saved Orca native 한글 ✓'),
      'Returned page could not submit input'
    )
    await capture(page, 'returnedScreenshot', entered)
    await record('returned', { shell: await shell(true), entered })
    await FileSystem.writeAsStringAsync(
      stateFile,
      JSON.stringify({ page, moduleId: initial.moduleId, contents: entered })
    )
    await record('beforeReload', { page, moduleId: initial.moduleId })
    await reloadAppAsync('Native browser lifetime fixture')
  } catch (error) {
    await record('failure', String(error))
  }
}
