import { asRecord, optionalFlag, requiredString } from './herdr-stock-cli-flags'

export function sessionCliArgs(method: string, rawParams: unknown): string[] | null {
  const params = asRecord(rawParams)
  switch (method) {
    case 'session.snapshot':
      return ['api', 'snapshot']
    case 'notification.show':
      return [
        'notification',
        'show',
        requiredString(params.title, 'title'),
        ...optionalFlag('--body', params.body),
        ...optionalFlag('--position', params.position),
        ...optionalFlag('--sound', params.sound)
      ]
    case 'server.live_handoff':
      return [
        'server',
        'live-handoff',
        ...optionalFlag('--expected-protocol', params.expected_protocol),
        ...optionalFlag('--expected-version', params.expected_version),
        ...optionalFlag('--import-exe', params.import_exe)
      ]
    default:
      return null
  }
}
