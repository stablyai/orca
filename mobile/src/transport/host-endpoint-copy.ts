import { translate } from '../i18n/mobile-i18n'

export const hostEndpointCopy = {
  addressRequired: () =>
    translate('connection.hostEndpoint.addressRequired', 'Enter a host address.'),
  invalidPort: () => translate('connection.hostEndpoint.invalidPort', 'Port must be 1–65535.'),
  invalidScheme: () =>
    translate('connection.hostEndpoint.invalidScheme', 'Use ws:// or wss:// (or host:port).'),
  invalidAddress: () => translate('connection.hostEndpoint.invalidAddress', 'Not a valid address.'),
  pathOrQueryNotAllowed: () =>
    translate(
      'connection.hostEndpoint.pathOrQueryNotAllowed',
      'Host must not include a path or query.'
    ),
  invalidHostname: () =>
    translate('connection.hostEndpoint.invalidHostname', 'Not a valid hostname.'),
  hostnameRequired: () => translate('connection.hostEndpoint.hostnameRequired', 'Missing hostname.')
}
