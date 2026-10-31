import { resolveBuildSourceCommit } from './build-source-commit.mjs'

export function resolveOrcadSourceCommit(
  env = process.env,
  fromCheckout = resolveBuildSourceCommit
) {
  const supplied = env.ORCAD_SOURCE_COMMIT
  if (supplied === undefined) {
    return fromCheckout()
  }
  if (!/^[0-9a-f]{40}$/.test(supplied)) {
    throw new Error('ORCAD_SOURCE_COMMIT must be a full lowercase 40-character Git revision')
  }
  return supplied
}
