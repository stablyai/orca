export type SshPtyExitBarrier = {
  timer: ReturnType<typeof setTimeout>
  reject: (error: Error) => void
}

export function outputIntakeError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

export function validOutputLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function sshPtyGenerationKey(ptyId: string, providerGeneration: number): string {
  return `${providerGeneration}\0${ptyId}`
}
