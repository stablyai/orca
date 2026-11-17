import { CLOUD_ENVIRONMENT_METHODS } from '../../../../../shared/hosted-sandbox/hosted-environment-cli-contract'
import { hostedEnvironmentError } from '../../../../../shared/hosted-sandbox/hosted-environment-errors'
import {
  CloudEnvironmentFollowBuildParams,
  CloudEnvironmentSelectParams,
  CloudEnvironmentSetInstallScriptParams,
  CloudEnvironmentShowParams
} from '../../../../../shared/rpc-contract/cloud-environment-params'
import { createHostedEnvironmentBuildFollowers } from '../../../../hosted-sandbox/environments/hosted-environment-build-followers'
import {
  followCloudEnvironmentBuild,
  listCloudEnvironmentBuilds,
  setCloudEnvironmentInstallScript,
  showCloudEnvironment,
  startCloudEnvironmentBuild
} from '../../../../hosted-sandbox/environments/hosted-environment-cli-operations'
import type { HostedEnvironmentClient } from '../../../../hosted-sandbox/environments/hosted-environment-client'
import {
  getHostedEnvironmentService,
  hostedEnvironmentResult
} from '../../../../hosted-sandbox/environments/hosted-environment-service'
import { defineMethod } from '../../core'

const followers = createHostedEnvironmentBuildFollowers()

/** The desktop holds the Orca Cloud session; a headless server has no service registered. */
function withClient<T>(work: (client: HostedEnvironmentClient) => Promise<T>) {
  const service = getHostedEnvironmentService()
  if (!service) {
    return Promise.resolve({
      ok: false as const,
      error: {
        ...hostedEnvironmentError('not_configured'),
        message:
          'Orca Cloud environments are managed from the Orca desktop app; run this where it is open.'
      }
    })
  }
  return hostedEnvironmentResult(() => work(service.client()))
}

// `workspace` like other agent-facing integrations; the surface itself can only edit the install
// script and run builds (see hosted-environment-cli-operations.ts).
export const CLOUD_ENVIRONMENT_METHODS_RPC = [
  defineMethod({
    name: CLOUD_ENVIRONMENT_METHODS.show,
    permission: 'workspace',
    params: CloudEnvironmentShowParams,
    handler: ({ env, refresh }) =>
      withClient((client) => showCloudEnvironment(client, env, refresh === true))
  }),
  defineMethod({
    name: CLOUD_ENVIRONMENT_METHODS.setInstallScript,
    permission: 'workspace',
    params: CloudEnvironmentSetInstallScriptParams,
    handler: ({ env, script, expectedRevision }) =>
      withClient((client) =>
        setCloudEnvironmentInstallScript(client, env, script, expectedRevision)
      )
  }),
  defineMethod({
    name: CLOUD_ENVIRONMENT_METHODS.startBuild,
    permission: 'workspace',
    params: CloudEnvironmentSelectParams,
    handler: ({ env }) => withClient((client) => startCloudEnvironmentBuild(client, env))
  }),
  defineMethod({
    name: CLOUD_ENVIRONMENT_METHODS.builds,
    permission: 'workspace',
    params: CloudEnvironmentSelectParams,
    handler: ({ env }) => withClient((client) => listCloudEnvironmentBuilds(client, env))
  }),
  defineMethod({
    name: CLOUD_ENVIRONMENT_METHODS.followBuild,
    permission: 'workspace',
    params: CloudEnvironmentFollowBuildParams,
    handler: (params) =>
      withClient((client) => followCloudEnvironmentBuild(client, followers, params))
  })
]
