import { createContext, useContext } from 'react'

/** True under a mounted but hidden screen part (a visited Home tab); its working loops stop until shown. */
export const WorkingMotionPaused = createContext(false)

export function useWorkingMotionActive(active: boolean): boolean {
  const paused = useContext(WorkingMotionPaused)
  return active && !paused
}
