import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasTerraformRoot,
  renderAttributeConditions
} from './render-workload-identity-conditions.mjs'

// GCP rejects an attribute_condition longer than this.
const ATTRIBUTE_CONDITION_LIMIT = 4096

const EXPECTED_CONDITIONS = {
  staging: {
    relay: {
      github_staging_relay_capacity:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/prove-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/recover-relay-staging-c4-image.yml@refs/heads/main')) || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && (assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-prove-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-recover-relay-staging-c4-image.yml@refs/heads/main')))",
      github_staging_relay_deploy:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-staging-gce-candidate.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/power-relay-staging.yml@refs/heads/main')) || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && (assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-staging-gce-candidate.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-power-relay-staging.yml@refs/heads/main')))",
      github_relay_asia_topology:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && assertion.event_name == 'workflow_dispatch' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-asia-topology.yml@refs/heads/main') || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-asia-topology.yml@refs/heads/main'))",
      github_relay_asia_proof:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && assertion.event_name == 'workflow_dispatch' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/prove-relay-asia-staging.yml@refs/heads/main') || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-prove-relay-asia-staging.yml@refs/heads/main'))",
    },
    // The relay root creates this provider only in production, so staging has exactly one
    // definition and it lives here.
    apps: {
      github:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-auth-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/load-skill-finalization-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/recover-skill-object-staging.yml@refs/heads/main')",
    },
  },
  production: {
    relay: {
      github:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && ((assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-fence-broker.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-director.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/publish-relay-production.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-production-rehome.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-production-rehome-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main' && (assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap-job.yml@refs/heads/main' || assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main')))) || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && ((assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-fence-broker.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-director.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-multi-target.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-publish-relay-production.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-operate-relay-production-rehome.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-operate-relay-production-rehome-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-same-cap.yml@refs/heads/main' && (assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-same-cap-job.yml@refs/heads/main' || assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-same-cap.yml@refs/heads/main')))))",
      github_monitor:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/monitor-relay-production.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/monitor-relay-production-job.yml@refs/heads/main') || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-monitor-relay-production.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-monitor-relay-production-job.yml@refs/heads/main'))",
      github_fence:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main') || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-multi-target.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-multi-target.yml@refs/heads/main'))",
      github_production_relay_capacity:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && ((assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap-job.yml@refs/heads/main'))) || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && ((assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-capacity.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-capacity-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-same-cap.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-production-same-cap-job.yml@refs/heads/main'))))",
      github_relay_asia_topology:
        "assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.event_name == 'workflow_dispatch' && ((assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-asia-topology.yml@refs/heads/main') || (assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420' && assertion.workflow_ref == 'stablyai/orca/.github/workflows/cloud-deploy-relay-asia-topology.yml@refs/heads/main'))",
    },
    apps: {
      github_production_app_deploy:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-production.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-auth-production.yml@refs/heads/main')",
    },
  },
}

// Every repository the relay root accepts while the public extraction runs, with the workflow-ref
// head each one contributes. The apps root is not part of the dual accept.
const ACCEPTED_REPOSITORIES = [
  {
    claims:
      "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420'",
    workflowHead: 'stablyai/orca-cloud/.github/workflows/'
  },
  {
    claims:
      "assertion.repository == 'stablyai/orca' && assertion.repository_id == '1183888342' && assertion.repository_owner_id == '127256420'",
    workflowHead: 'stablyai/orca/.github/workflows/cloud-'
  }
]

// [root, provider, condition] for every provider the environment creates, across all roots.
async function flatten(environment) {
  const rendered = await renderAttributeConditions(environment)
  return Object.entries(rendered).flatMap(([root, providers]) =>
    Object.entries(providers).map(([provider, condition]) => [root, provider, condition])
  )
}

// Only roots whose directory ships can be rendered; the apps root stays in the private
// repository, so its expectations sit above unused until that directory is present.
const expectedRoots = (environment) =>
  Object.fromEntries(
    Object.entries(EXPECTED_CONDITIONS[environment]).filter(([root]) => hasTerraformRoot(root))
  )

for (const environment of Object.keys(EXPECTED_CONDITIONS)) {
  const roots = expectedRoots(environment)
  test(`${environment} renders the exact reviewed attribute conditions`, async () => {
    const rendered = await renderAttributeConditions(environment)
    assert.deepEqual(Object.keys(rendered).sort(), Object.keys(roots).sort())
    for (const [root, providers] of Object.entries(roots)) {
      assert.deepEqual(Object.keys(rendered[root]).sort(), Object.keys(providers).sort(), root)
      for (const [provider, condition] of Object.entries(providers)) {
        assert.equal(rendered[root][provider], condition, `${environment} ${root} ${provider}`)
      }
    }
  })

  test(`${environment} attribute conditions stay under the GCP length limit`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      assert.ok(
        condition.length < ATTRIBUTE_CONDITION_LIMIT,
        `${environment} ${root} ${provider} is ${condition.length} chars`
      )
    }
  })

  test(`${environment} pins repository, branch, and environment on every provider`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      for (const pin of [
        "assertion.repository == 'stablyai/orca-cloud'",
        "assertion.repository_id == '1273841466'",
        "assertion.repository_owner_id == '127256420'",
        "assertion.ref == 'refs/heads/main'",
        `assertion.environment == '${environment}'`
      ]) {
        assert.ok(condition.includes(pin), `${environment} ${root} ${provider} is missing ${pin}`)
      }
      assert.ok(
        condition.includes('assertion.workflow_ref ==') ||
          condition.includes('assertion.job_workflow_ref =='),
        `${environment} ${root} ${provider} names no workflow`
      )
    }
  })

  // A prefix or suffix match would turn each allowlist into a namespace grant.
  test(`${environment} attribute conditions compare workflows only by equality`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      assert.doesNotMatch(
        condition,
        /startsWith|endsWith|matches|in \[/,
        `${environment} ${root} ${provider}`
      )
    }
  })
}

// Why: the dual accept is only safe if each OR arm carries its own repository claims. An arm that
// inherited them, or a workflow ref that named the other repository, would let one repository's
// workflows run under the other's proof.
for (const environment of Object.keys(EXPECTED_CONDITIONS)) {
  test(`${environment} admits both repositories through every relay provider`, async () => {
    const rendered = await renderAttributeConditions(environment)
    for (const [provider, condition] of Object.entries(rendered.relay)) {
      assert.ok(
        condition.startsWith("assertion.ref == 'refs/heads/main' && "),
        `${provider} does not lead with the repository-independent claims`
      )
      const refs = [...condition.matchAll(/(?:job_)?workflow_ref == '([^']+)'/g)].map(
        (match) => match[1]
      )
      const perRepository = ACCEPTED_REPOSITORIES.map((repository) => {
        assert.ok(condition.includes(`(${repository.claims} && `), `${provider} misses an arm`)
        return refs.filter((ref) => ref.startsWith(repository.workflowHead)).length
      })
      assert.equal(refs.length, perRepository[0] + perRepository[1], `${provider} names a stray ref`)
      assert.equal(perRepository[0], perRepository[1], `${provider} arms are not the same size`)
      assert.ok(perRepository[0] > 0, `${provider} names no workflow`)
    }
  })
}
