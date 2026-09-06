import { MobileSessionSurface } from '../../../../src/session/MobileSessionSurface'
import { useMobileSessionController } from '../../../../src/session/use-mobile-session-controller'
import type { MobileSessionScreenProps } from '../../../../src/session/use-mobile-session-foundation'

export { SessionScreen as default }

export function SessionScreen(props: MobileSessionScreenProps = {}) {
  const controller = useMobileSessionController(props)
  return <MobileSessionSurface controller={controller} />
}
