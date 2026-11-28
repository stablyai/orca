import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import {
  LAYOUT_OWNER_FLAG_DIR_KEY,
  LAYOUT_OWNER_FLAG_FILE_NAME,
  type LayoutOwnerStartupScope
} from '../../shared/workspace-layout/layout-owner-startup'
import { resolveHostLayoutOwner } from './host-layout-owner'

/** The banner reads the flag before userData is final; a flag only the final folder holds waits for the next launch. */
export async function warnIfLayoutOwnerFlagMoved(userDataPath: string): Promise<void> {
  const startup: LayoutOwnerStartupScope = globalThis
  const readFrom = startup[LAYOUT_OWNER_FLAG_DIR_KEY]
  if (typeof readFrom !== 'string' || resolve(readFrom) === resolve(userDataPath)) {
    return
  }
  const flag = await readFile(join(userDataPath, LAYOUT_OWNER_FLAG_FILE_NAME), 'utf8').catch(
    () => undefined
  )
  const { owner } = resolveHostLayoutOwner({ server: false, env: {}, readFlag: () => flag })
  if ((owner === 'main') !== ORCA_LAYOUT_OWNER_IS_MAIN) {
    console.warn(
      `[layout-owner] ${LAYOUT_OWNER_FLAG_FILE_NAME} in ${userDataPath} asks for ${owner}, but startup read ${readFrom}; keeping ${ORCA_LAYOUT_OWNER_IS_MAIN ? 'main' : 'window'} for this launch`
    )
  }
}
