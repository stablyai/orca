/** Only the revision-24 atomic session.create capacity rejection proves no dispatch. */
export class RexSessionCapacityError extends Error {
  constructor() {
    super(
      'Rex server session limit reached. Close unused sessions in Rex or configure its max-sessions limit.'
    )
  }
}

export function classifyRexRpcRejection(method: string, error: unknown): Error {
  if (
    method === 'session.create' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'conflict' &&
    'status' in error &&
    error.status === 409 &&
    'message' in error &&
    typeof error.message === 'string' &&
    /^server already has its maximum of [1-9][0-9]* sessions; destroy one before creating another$/.test(
      error.message
    )
  ) {
    return new RexSessionCapacityError()
  }
  return new Error('Rex RPC rejected')
}
