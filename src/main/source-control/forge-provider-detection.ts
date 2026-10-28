import type { ForgeProvider, ForgeProviderRepositoryContext } from './forge-provider'

export async function selectForgeProvider(
  providers: readonly ForgeProvider[],
  context: ForgeProviderRepositoryContext
): Promise<ForgeProvider | null> {
  let githubIdentityError: unknown
  for (const provider of providers) {
    try {
      if (await provider.resolveRepository(context)) {
        return provider
      }
    } catch (error) {
      if (
        provider.id !== 'github' ||
        !(error instanceof Error) ||
        !error.message.startsWith('github_participant_')
      ) {
        throw error
      }
      // Other forges can identify their remote without a GitHub participant.
      githubIdentityError = error
    }
  }
  if (githubIdentityError) {
    throw githubIdentityError
  }
  return null
}
