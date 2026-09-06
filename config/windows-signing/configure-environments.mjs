import { pathToFileURL } from 'node:url'

export async function configureEnvironments(env = process.env, fetchImpl = fetch) {
  const token = env.GH_TOKEN
  const appId = Number(env.SIGNING_GATE_APP_ID)
  if (!token || !Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error(
      'GH_TOKEN with repository administration access and SIGNING_GATE_APP_ID are required'
    )
  }
  const branch = env.SIGNING_REHEARSAL_BRANCH || 'main'
  const root = 'https://api.github.com/repos/stablyai/orca/environments'
  async function api(path, method = 'GET', body, missingAllowed = false) {
    const response = await fetchImpl(`${root}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    if (missingAllowed && response.status === 404) {
      return undefined
    }
    if (!response.ok) {
      throw new Error(`Environment configuration failed: ${method} ${path} (${response.status})`)
    }
    return response.status === 204 ? undefined : response.json()
  }
  for (const prefix of ['windows', 'windows-rehearsal']) {
    for (const stage of ['inner', 'installer']) {
      const name = `${prefix}-${stage}-signing`
      const existing = await api(name, 'GET', undefined, true)
      if (
        existing?.protection_rules?.some((rule) =>
          ['required_reviewers', 'wait_timer'].includes(rule.type)
        )
      ) {
        throw new Error(`Refusing to replace existing human/timer protection on ${name}`)
      }
      const allowedBranch = prefix === 'windows' ? 'main' : branch
      if (existing) {
        const branches = await api(`${name}/deployment-branch-policies?per_page=100`)
        if (
          branches.total_count > 100 ||
          branches.branch_policies.some(
            (policy) => policy.name !== allowedBranch || policy.type !== 'branch'
          )
        ) {
          throw new Error(
            `Unexpected existing branch policy on ${name}; inspect it before changing signing protection`
          )
        }
      }
      await api(name, 'PUT', {
        can_admins_bypass: false,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
      })
      const branches = await api(`${name}/deployment-branch-policies?per_page=100`)
      if (
        !branches.branch_policies.some(
          (policy) => policy.name === allowedBranch && policy.type === 'branch'
        )
      ) {
        await api(`${name}/deployment-branch-policies`, 'POST', {
          name: allowedBranch,
          type: 'branch'
        })
      }
      const rules = await api(`${name}/deployment_protection_rules`)
      if (
        !rules.custom_deployment_protection_rules.some(
          (rule) => rule.enabled && rule.app.id === appId
        )
      ) {
        await api(`${name}/deployment_protection_rules`, 'POST', { integration_id: appId })
      }
      console.log(`Configured ${name} for ${allowedBranch}; verify /ready before running signing.`)
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await configureEnvironments()
}
