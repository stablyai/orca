import type { PetEdge, PetPoint } from '../../../src/shared/pet-presence'

/** How close to an edge counts as touching it, in normalized units. Mirrors the
 *  desktop's threshold so a pet leaves both surfaces at the same proximity. */
const EDGE_THRESHOLD = 0.02

/** Which edge (if any) a normalized position is against. Horizontal wins in a
 *  corner: handing off sideways reads as walking out of a screen, upward reads
 *  as falling out of one. */
export function edgeAtNormalized(position: PetPoint): PetEdge | null {
  if (position.x <= EDGE_THRESHOLD) {
    return 'left'
  }
  if (position.x >= 1 - EDGE_THRESHOLD) {
    return 'right'
  }
  if (position.y <= EDGE_THRESHOLD) {
    return 'top'
  }
  if (position.y >= 1 - EDGE_THRESHOLD) {
    return 'bottom'
  }
  return null
}
