import { readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export function canonicalCodexHome(home: string): string {
  try {
    return realpathSync(home)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return resolve(home)
  }
}

/** An overlay names its store through directory links; legacy homes remain stores themselves. */
export function codexConversationStore(home: string): string {
  if (basename(dirname(home)) !== 'overlays') {
    return canonicalCodexHome(home)
  }
  return canonicalCodexHome(dirname(resolve(home, readlinkSync(join(home, 'sessions')))))
}
