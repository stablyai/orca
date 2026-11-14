import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserExtensionDocumentTargets } from './browser-extension-document-targets'

type Injection = {
  target: Record<string, unknown>
  files?: string[] | null
  func?: ((...args: unknown[]) => unknown) | null
  function?: ((...args: unknown[]) => unknown) | null
  args?: unknown[] | null
  world?: string | null
}
function install() {
  const calls: Injection[] = []
  let live = true
  let navigate = false
  const executeScript = async (injection: Injection) => {
    calls.push(injection)
    if (
      (injection.files &&
        (injection.files.length === 0 || injection.func || injection.function || injection.args)) ||
      (injection.func && injection.function)
    ) {
      throw new Error('native validation')
    }
    if (injection.files?.[0] === 'own-prefix.js') {
      if (navigate) {
        live = false
      }
      return [
        { documentId: 'exact-native-document', frameId: 0, result: { orcaPrefix: 'initialized' } }
      ]
    }
    const result = await (injection.func ?? injection.function)?.(...(injection.args ?? []))
    return [{ documentId: 'exact-native-document', frameId: 0, result }]
  }
  const chrome = { runtime: {}, scripting: { executeScript } }
  const bridge = {
    call: async (_namespace: string, method: string, args: unknown[]) =>
      method === 'prefix' && live && (args.length === 0 || args[0] === 'own-generation')
        ? { ok: true, value: { file: 'own-prefix.js', execution: 'own-generation' } }
        : { ok: false, error: 'unloaded' },
    onEvent: () => {},
    listen: () => {},
    passesFilter: () => true
  }
  runInNewContext(`(${installBrowserExtensionDocumentTargets.toString()})(bridge, 1000000000)`, {
    chrome,
    bridge
  })
  return {
    chrome,
    calls,
    retireDuringPrefix: () => {
      navigate = true
    }
  }
}
afterEach(() => vi.useRealTimers())

it('prepends only its immutable generation file and leaves invalid and MAIN requests native', async () => {
  const { chrome, calls } = install()
  await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['original.js'] })
  expect(calls[0].files).toEqual(['own-prefix.js', 'original.js'])
  const invalid = { target: { tabId: 1 }, files: [] }
  await expect(chrome.scripting.executeScript(invalid)).rejects.toThrow('native validation')
  const incompatible = { target: { tabId: 1 }, files: ['original.js'], func: () => 1 }
  await expect(chrome.scripting.executeScript(incompatible)).rejects.toThrow('native validation')
  await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['main.js'], world: 'MAIN' })
  expect(calls.at(-1)?.files).toEqual(['main.js'])
})

it('keeps the original function/args and exact initialized native document through a long promise', async () => {
  vi.useFakeTimers()
  const { chrome, calls } = install()
  let complete: (value: string) => void = () => {}
  const original = (argument: unknown) =>
    new Promise((resolve) => {
      expect(argument).toBe('native argument')
      complete = resolve
    })
  const result = chrome.scripting.executeScript({
    target: { tabId: 1, allFrames: true },
    func: original,
    args: ['native argument']
  })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(calls[1].func).toBe(original)
  expect(calls[1].target).toEqual({ tabId: 1, documentIds: ['exact-native-document'] })
  complete('native result')
  await expect(result).resolves.toEqual([
    { documentId: 'exact-native-document', frameId: 0, result: 'native result' }
  ])
})

it('initializes native-valid omitted optional fields and the native function alias', async () => {
  for (const omitted of [
    { args: undefined },
    { func: undefined },
    { function: undefined },
    { args: null },
    { func: null },
    { function: null },
    { world: null }
  ]) {
    const { chrome, calls } = install()
    await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['reader.js'], ...omitted })
    expect(calls[0].files).toEqual(['own-prefix.js', 'reader.js'])
  }
  const original = (value: unknown) => value
  for (const input of [
    { func: original, files: undefined },
    { function: original, func: undefined },
    { func: original, files: null },
    { function: original, func: null, files: null, world: null }
  ]) {
    const { chrome, calls } = install()
    await expect(
      chrome.scripting.executeScript({ target: { tabId: 1 }, args: ['retained'], ...input })
    ).resolves.toEqual([{ documentId: 'exact-native-document', frameId: 0, result: 'retained' }])
    expect(calls[0].files).toEqual(['own-prefix.js'])
    expect(calls[1].func ?? calls[1].function).toBe(original)
    expect(calls[1].target).toEqual({ tabId: 1, documentIds: ['exact-native-document'] })
  }
  const { chrome } = install()
  await expect(
    chrome.scripting.executeScript({ target: { tabId: 1 }, func: original, function: original })
  ).rejects.toThrow('native validation')
})

it('does not run the function or obtain a successor after its generation retires during the prefix', async () => {
  const { chrome, retireDuringPrefix, calls } = install()
  retireDuringPrefix()
  const original = () => 'must not run'
  await expect(
    chrome.scripting.executeScript({ target: { tabId: 1 }, func: original })
  ).rejects.toThrow('unloaded')
  expect(calls.some((call) => call.func === original)).toBe(false)
})
