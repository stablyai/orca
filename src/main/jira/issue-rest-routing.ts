import type { JiraSite, JiraSiteSelection } from '../../shared/types'

export function isServerSite(site: JiraSite): boolean {
  return site.deploymentType === 'server'
}

export function restApiBase(site: JiraSite): string {
  return isServerSite(site) ? '/rest/api/2' : '/rest/api/3'
}

export function shouldSurfaceSiteFailure(
  selection: JiraSiteSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all' choice;
  // multi-entry reads need the same resilient fan-out policy as explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}
