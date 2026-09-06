export const HOSTED_MOBILE_APP_ROUTE_URL = 'orca:///hybrid'

export function hostedMobileMetroArguments(port, freshPublicEnvironment) {
  return [
    'start',
    '--host',
    'lan',
    '--port',
    String(port),
    ...(freshPublicEnvironment ? ['--clear'] : [])
  ]
}
