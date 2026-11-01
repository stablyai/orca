import { shell } from 'electron'

/**
 * An e2e launch must never open the tester's browser or mail client: `shell.openExternal` only
 * logs there. Specs that observe opens replace it themselves, and restore this guard after.
 */
export function guardExternalOpensInE2E(): void {
  shell.openExternal = async (url: string): Promise<void> => {
    console.info(`[e2e] shell.openExternal suppressed: ${url.split(':', 1)[0]}:`)
  }
}
