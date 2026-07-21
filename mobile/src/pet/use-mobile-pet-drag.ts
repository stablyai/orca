import { useMemo, useRef, useState } from 'react'
import { PanResponder, type PanResponderInstance } from 'react-native'
import { clampPositionToViewport, type Position } from '../../../src/shared/pet-roam'
import {
  facingForDragAnimation,
  nextPetDragAnimation,
  type PetDragAnimation
} from '../../../src/shared/pet-drag'

/**
 * Touch interaction for the pet on the phone: pick it up, drag it, put it down.
 *
 * The desktop equivalent is usePetPointerInteraction. Both reduce a stream of
 * pointer positions to the same three facts — dragging, facing, and a
 * generation counter that restarts the sprite on grab — via the same shared
 * direction rule, so the creature behaves identically on either screen.
 *
 * PanResponder rather than react-native-gesture-handler: this needs no root
 * view provider and no native config, and the interaction is a plain single-
 * touch drag. Fewer moving parts on the surface that is hardest to debug.
 *
 * Position stays LOCAL. The phone is not the authority and never writes the
 * pet's position over RPC — dragging moves the pet on this screen, and only a
 * genuine edge crossing tells the authority anything.
 */

export type MobilePetDrag = {
  dragging: boolean
  /** Facing implied by the drag, or null when the drag has not committed. */
  dragFacing: 'left' | 'right' | null
  /** Bumped on each grab so the sprite can restart from frame 0. */
  dragGeneration: number
  /** Spread onto the pet's View to make it grabbable. */
  panHandlers: PanResponderInstance['panHandlers']
}

/** How far a touch may travel and still count as a tap rather than a drag.
 *  Generous relative to the desktop's 4px turn threshold because a finger is
 *  not a mouse and a "still" finger drifts several pixels. */
const TAP_SLOP_PX = 8

export function useMobilePetDrag({
  position,
  size,
  viewport,
  setPosition,
  onTap
}: {
  position: Position
  size: number
  viewport: { width: number; height: number }
  setPosition: (next: Position) => void
  onTap: () => void
}): MobilePetDrag {
  const [dragging, setDragging] = useState(false)
  const [dragFacing, setDragFacing] = useState<'left' | 'right' | null>(null)
  const [dragGeneration, setDragGeneration] = useState(0)

  // Refs, not state: these are read and written inside gesture callbacks, where
  // React's render batching would let two coalesced moves resurrect a stale
  // direction. Same reasoning as the desktop hook.
  const grabPositionRef = useRef<Position>({ x: 0, y: 0 })
  const directionRef = useRef<PetDragAnimation>(null)
  const baselineXRef = useRef(0)
  const travelledRef = useRef(0)
  const positionRef = useRef(position)
  positionRef.current = position
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const onTapRef = useRef(onTap)
  onTapRef.current = onTap

  // Built once: PanResponder captures its callbacks at creation, so rebuilding
  // it mid-gesture would drop the in-flight touch. Everything it needs that can
  // change is read through a ref.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        // Claim the move too, so a drag that starts on the pet is not stolen by
        // a scroll view underneath once it passes that view's own slop.
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: () => {
          grabPositionRef.current = positionRef.current
          baselineXRef.current = 0
          directionRef.current = null
          travelledRef.current = 0
          setDragging(true)
          setDragFacing(null)
          setDragGeneration((generation) => generation + 1)
        },

        onPanResponderMove: (_event, gesture) => {
          travelledRef.current = Math.max(
            travelledRef.current,
            Math.hypot(gesture.dx, gesture.dy)
          )

          const turn = nextPetDragAnimation(
            directionRef.current,
            gesture.dx - baselineXRef.current
          )
          if (turn.accepted) {
            baselineXRef.current = gesture.dx
            if (turn.animation !== directionRef.current) {
              directionRef.current = turn.animation
              setDragFacing((previous) =>
                facingForDragAnimation(turn.animation, previous ?? 'right')
              )
            }
          }

          // Clamp on the way in: the pet must not be draggable off its own
          // screen. Leaving is a walk across an edge, not a throw.
          setPosition(
            clampPositionToViewport(
              {
                x: grabPositionRef.current.x + gesture.dx,
                y: grabPositionRef.current.y + gesture.dy
              },
              size,
              viewportRef.current
            )
          )
        },

        onPanResponderRelease: () => {
          if (travelledRef.current <= TAP_SLOP_PX) {
            onTapRef.current()
          }
          directionRef.current = null
          setDragging(false)
          setDragFacing(null)
        },

        // A terminated gesture (a parent view winning the responder, an
        // incoming call) must not leave the pet wedged in the dragging state
        // with its roam loop paused forever.
        onPanResponderTerminate: () => {
          directionRef.current = null
          setDragging(false)
          setDragFacing(null)
        }
      }),
    [setPosition, size]
  )

  return {
    dragging,
    dragFacing,
    dragGeneration,
    panHandlers: responder.panHandlers
  }
}
