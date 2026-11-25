// Host-checked rules (Gmail, Calendar, Teams) ride the host's automation tick beside Look around, on
// desktop and `orca serve` alike.
import type { AutomationService } from './automation-service'

export function rideAutomationTick(
  service: Pick<AutomationService, 'onTick' | 'stop'>,
  checker: { tick(): Promise<void>; stop(): void }
): void {
  const earlier = service.onTick
  service.onTick = () => {
    earlier?.()
    void checker.tick()
  }
  const stop = service.stop.bind(service)
  service.stop = () => {
    checker.stop()
    stop()
  }
}
