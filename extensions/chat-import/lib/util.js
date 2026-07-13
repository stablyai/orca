function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const Util = { sleep }
if (typeof module !== 'undefined') module.exports = Util
if (typeof globalThis !== 'undefined') globalThis.Util = Util
