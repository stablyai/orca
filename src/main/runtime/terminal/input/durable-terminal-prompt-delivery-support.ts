// Durable prompt delivery stores pending prompts in node:sqlite; hosts without it cannot advertise the capability.
export function supportsDurableTerminalPromptDelivery(): boolean {
  if (typeof process.getBuiltinModule !== 'function') {
    return false
  }
  try {
    return process.getBuiltinModule('node:sqlite') !== undefined
  } catch {
    return false
  }
}
