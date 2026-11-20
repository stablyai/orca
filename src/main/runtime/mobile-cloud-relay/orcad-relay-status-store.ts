import type {
  MobileRelayStatus,
  MobileRelayStatusDetail
} from '../../../shared/remote-runtime/relay/mobile-relay-status'

let lastRelayStatus: MobileRelayStatusDetail = { status: 'offline' }

export function setLastRelayStatus(status: MobileRelayStatus, cellUrl?: string): void {
  lastRelayStatus = cellUrl ? { status, cellUrl } : { status }
}

export function getLastRelayStatus(): MobileRelayStatusDetail {
  return lastRelayStatus
}
