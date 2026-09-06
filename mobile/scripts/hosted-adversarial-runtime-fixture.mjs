import {
  createHostedAdversarialProviderFixture,
  removeHostedAdversarialProviderFixture
} from './hosted-adversarial-provider-fixture.mjs'
import {
  createHostedAdversarialRepositoryFixture,
  removeHostedAdversarialRepositoryFixture
} from './hosted-adversarial-repository-fixture.mjs'

export async function createHostedAdversarialRuntimeFixture({ probePort }) {
  const repository = await createHostedAdversarialRepositoryFixture({ probePort })
  try {
    const provider = await createHostedAdversarialProviderFixture({
      probePort,
      repositoryRoot: repository.root
    })
    return { ...repository, environment: provider.environment, provider }
  } catch (error) {
    await removeHostedAdversarialRepositoryFixture(repository)
    throw error
  }
}

export async function removeHostedAdversarialRuntimeFixture(fixture) {
  await removeHostedAdversarialProviderFixture(fixture.provider, fixture.root)
  await removeHostedAdversarialRepositoryFixture(fixture)
}
