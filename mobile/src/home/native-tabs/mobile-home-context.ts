import { createContext, useContext } from 'react'
import type { MobileHomeController } from '../use-mobile-home-controller'

/** Home's controller, owned by the tabs layout so every tab reads the same data and sheets. */
export const MobileHomeContext = createContext<MobileHomeController | null>(null)

export function useMobileHome(): MobileHomeController {
  const home = useContext(MobileHomeContext)
  if (!home) {
    throw new Error('useMobileHome must be used under the Home tabs layout')
  }
  return home
}
