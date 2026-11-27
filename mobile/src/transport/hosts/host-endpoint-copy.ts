import type { Translate } from '../../i18n/mobile-i18n'

export const hostEndpointCopy = {
  addressRequired: (t: Translate) =>
    t('connection.hostEndpoint.addressRequired', 'Enter a host address.'),
  invalidPort: (t: Translate) => t('connection.hostEndpoint.invalidPort', 'Port must be 1–65535.'),
  invalidScheme: (t: Translate) =>
    t('connection.hostEndpoint.invalidScheme', 'Use ws:// or wss:// (or host:port).'),
  invalidAddress: (t: Translate) =>
    t('connection.hostEndpoint.invalidAddress', 'Not a valid address.'),
  pathOrQueryNotAllowed: (t: Translate) =>
    t('connection.hostEndpoint.pathOrQueryNotAllowed', 'Host must not include a path or query.'),
  invalidHostname: (t: Translate) =>
    t('connection.hostEndpoint.invalidHostname', 'Not a valid hostname.'),
  hostnameRequired: (t: Translate) =>
    t('connection.hostEndpoint.hostnameRequired', 'Missing hostname.')
}
