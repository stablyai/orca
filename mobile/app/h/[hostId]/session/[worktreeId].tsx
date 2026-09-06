import { MobileSessionSurface } from '../../../../src/session/MobileSessionSurface'
import { useMobileSessionController } from '../../../../src/session/use-mobile-session-controller'

export default function SessionScreen() {
  const controller = useMobileSessionController()
  return <MobileSessionSurface controller={controller} />
}
