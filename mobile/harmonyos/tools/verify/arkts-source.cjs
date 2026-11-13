const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')

const sourceRoot = path.resolve(__dirname, '../../entry/src/main/ets')
function loadArkts(file, names, bindings = {}) {
  const source = fs
    .readFileSync(path.join(sourceRoot, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  const executable = stripTypeScriptTypes(source, { mode: 'transform' }).replace(
    /\bexport\s+(?:default\s+)?(?=(class|const|function|async|let|var)\b)/g,
    ''
  )
  let timerSequence = 0
  const timerHandles = new Map()
  return vm.runInNewContext(`${executable}\n;({${names.join(',')}})`, {
    console,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    TextDecoder,
    // HarmonyOS timers return positive numbers; Node fake timers use opaque handles.
    setTimeout(callback, delay) {
      const id = ++timerSequence
      timerHandles.set(
        id,
        setTimeout(() => {
          timerHandles.delete(id)
          callback()
        }, delay)
      )
      return id
    },
    clearTimeout(id) {
      clearTimeout(timerHandles.get(id))
      timerHandles.delete(id)
    },
    ...bindings
  })
}
const util = {
  generateRandomUUID: require('node:crypto').randomUUID,
  TextEncoder: class {
    encodeInto(value) {
      return new TextEncoder().encode(value)
    }
  },
  TextDecoder: { create: () => ({ decodeToString: (bytes) => new TextDecoder().decode(bytes) }) },
  Base64Helper: class {
    encodeToStringSync(bytes) {
      return Buffer.from(bytes).toString('base64')
    }
  }
}
module.exports = { loadArkts, util }
