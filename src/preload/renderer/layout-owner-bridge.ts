import { contextBridge } from 'electron'
import {
  LAYOUT_OWNER_GLOBAL,
  readLayoutOwnerArgument
} from '../../shared/workspace-layout/layout-owner-startup'

/** Runs before any page script, so the renderer's switch module reads main's value at its first import. */
export function exposeLayoutOwner(argv: readonly string[]): void {
  const { owner, problem } = readLayoutOwnerArgument(argv)
  if (problem) {
    console.warn(`[layout-owner] ${problem}; using the window path`)
  }
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld(LAYOUT_OWNER_GLOBAL, owner)
  } else {
    Reflect.set(window, LAYOUT_OWNER_GLOBAL, owner)
  }
}
