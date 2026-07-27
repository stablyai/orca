export type E2EEAuthenticatedDevice = {
  deviceId: string
  deviceToken: string
  scope: 'mobile' | 'runtime'
}
