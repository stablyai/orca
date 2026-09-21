import { elementInRoot } from './document-host-seams'
import { scope } from './document-scope'

/**
 * The first declarations inside the document's IIFE.
 *
 * All eight are read by other parts of the script, so all eight are scope fields; the document
 * shell opens the function they live in and `document-close.ts` closes it.
 */

export function startRuntimeConstants() {
  scope.surface = elementInRoot(scope.root, 'terminal-surface')
}
