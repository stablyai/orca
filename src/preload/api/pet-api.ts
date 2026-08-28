import type { CustomPet, PetAgentAnimation, PetWindowPosition } from '../../shared/pet-types'

export type PetApi = {
  import: () => Promise<CustomPet | null>
  importPetBundle: () => Promise<CustomPet | null>
  read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
  delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
}

/** Bridge between the main window (which owns agent state) and the detached pet window
 *  (which owns its own position and hit testing). */
export type DesktopPetApi = {
  /** Main window → pet window: the agent-derived animation to play. */
  publishAnimation: (animation: PetAgentAnimation) => Promise<void>
  /** Main window: republish because a pet window just mounted. */
  onAnimationRequested: (callback: () => void) => () => void
  /** Pet window: ask for the current animation on mount. */
  requestAnimation: () => Promise<void>
  onAnimation: (callback: (animation: PetAgentAnimation) => void) => () => void
  /** Pet window: move its own OS window to a screen position mid-drag. */
  move: (position: PetWindowPosition) => Promise<void>
  /** Pet window: take or release the mouse, so clicks pass through transparent corners. */
  setInteractive: (interactive: boolean) => Promise<void>
}
