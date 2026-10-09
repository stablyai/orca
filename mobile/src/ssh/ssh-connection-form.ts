export type SshConnectionForm = {
  name: string
  host: string
  port: string
  username: string
  targetHost: string
  targetPort: string
  hostKeyFingerprint: string
  jumpProfileId: string
  auth: 'password' | 'key'
  password: string
  privateKey: string
  passphrase: string
}

export const emptySshConnectionForm: SshConnectionForm = {
  name: '',
  host: '',
  port: '22',
  username: '',
  targetHost: 'localhost',
  targetPort: '',
  hostKeyFingerprint: '',
  jumpProfileId: '',
  auth: 'key',
  password: '',
  privateKey: '',
  passphrase: ''
}
