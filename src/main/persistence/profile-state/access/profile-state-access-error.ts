export class ProfileStateAccessError extends Error {
  readonly code = 'profile-state-access-refused' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProfileStateAccessError'
  }
}
