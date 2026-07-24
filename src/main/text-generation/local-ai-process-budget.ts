import type { ChildProcess } from 'node:child_process'

export const MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS = 8

type LocalAiProcessOwner = {
  child: ChildProcess
  closed: Promise<void>
  release: () => void
}

export type LocalAiProcessReservation = {
  waitForClose?: Promise<void>
  register: (child: ChildProcess, laneKey?: string) => LocalAiProcessOwner
  release: () => void
}

type ReplacementReservation = {
  reservation: LocalAiProcessReservation
  activate: () => void
}

const activeOwners = new Set<LocalAiProcessOwner>()
const reservedSlots = new Set<LocalAiProcessReservation>()
const ownerByLane = new Map<string, LocalAiProcessOwner>()
const replacementByOwner = new Map<LocalAiProcessOwner, ReplacementReservation>()

export function reserveLocalAiProcess(laneKey?: string): LocalAiProcessReservation | null {
  let predecessor: LocalAiProcessOwner | undefined
  if (activeOwners.size + reservedSlots.size >= MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS) {
    predecessor = laneKey ? ownerByLane.get(laneKey) : undefined
    if (!predecessor || replacementByOwner.has(predecessor)) {
      return null
    }
  }

  let state: 'waiting' | 'reserved' | 'registered' | 'released' = predecessor
    ? 'waiting'
    : 'reserved'
  let reservation: LocalAiProcessReservation
  const activate = (): void => {
    if (state !== 'waiting') {
      return
    }
    state = 'reserved'
    reservedSlots.add(reservation)
  }
  reservation = {
    waitForClose: predecessor?.closed,
    register: (child, ownerLaneKey) => {
      if (state !== 'reserved') {
        throw new Error('Local AI process reservation is not ready.')
      }
      reservedSlots.delete(reservation)
      state = 'registered'

      let released = false
      let resolveClosed = (): void => {}
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const owner: LocalAiProcessOwner = {
        child,
        closed,
        release: () => {
          if (released) {
            return
          }
          released = true
          activeOwners.delete(owner)
          if (ownerLaneKey && ownerByLane.get(ownerLaneKey) === owner) {
            ownerByLane.delete(ownerLaneKey)
          }
          const replacement = replacementByOwner.get(owner)
          if (replacement) {
            replacementByOwner.delete(owner)
            // Preserve the claimed slot before `closed` lets the replacement resume.
            replacement.activate()
          }
          resolveClosed()
        }
      }
      activeOwners.add(owner)
      if (ownerLaneKey) {
        ownerByLane.set(ownerLaneKey, owner)
      }
      return owner
    },
    release: () => {
      if (state === 'waiting' && predecessor) {
        const replacement = replacementByOwner.get(predecessor)
        if (replacement?.reservation === reservation) {
          replacementByOwner.delete(predecessor)
        }
        state = 'released'
        return
      }
      if (state === 'reserved') {
        reservedSlots.delete(reservation)
        state = 'released'
      }
    }
  }

  if (predecessor) {
    replacementByOwner.set(predecessor, { reservation, activate })
  } else {
    reservedSlots.add(reservation)
  }
  return reservation
}
