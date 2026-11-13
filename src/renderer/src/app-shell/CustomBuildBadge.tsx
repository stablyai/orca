import { useCallback, useState } from 'react'
import { ArrowRight, ChevronDown, GitPullRequest, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { getCustomBuildInfo } from '../../../shared/custom-build'
import { openCommunity, useCommunityNavigation } from '@/components/community/community-navigation'
import { communityClient, LOCAL_COMMUNITY_HOST } from '@/components/community/community-client'
import { useCommunityResource } from '@/components/community/use-community-resource'

export function CustomBuildBadge(): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const build = getCustomBuildInfo()
  const resource = useCommunityResource(
    useCallback(
      () => (open ? communityClient(LOCAL_COMMUNITY_HOST).features() : Promise.resolve(null)),
      [open]
    )
  )
  if (!build) {
    return null
  }
  const changes = [
    ...build.changes.filter((change) => change.pullRequest),
    ...build.changes.filter((change) => !change.pullRequest)
  ].slice(0, 3)
  const navigate = (number?: number): void => {
    setOpen(false)
    openCommunity(number ? 'proposals' : 'custom')
    if (number) {
      useCommunityNavigation.getState().open(number)
    }
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="mx-1 [-webkit-app-region:no-drag]"
          aria-label={t('community.customDetails', 'Custom build details')}
        >
          {t('community.customLabel', 'Custom')}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <Package className="size-5 text-muted-foreground" />
            <Badge variant="outline">
              {build.profileMode === 'shared-profile'
                ? t('community.sharedProfile', 'Shared profile')
                : t('community.previewBuild', 'Preview')}
            </Badge>
          </div>
          <h2 className="text-lg font-semibold">{t('community.myCustom', 'My Custom build')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('community.basedOn', 'Based on official Orca')} {build.baseVersion} ·{' '}
            {build.changes.length} {t('community.includedChanges', 'included changes')}
          </p>
        </div>
        <DropdownMenuSeparator />
        {changes.map((change) => {
          const preview = change.pullRequest
            ? resource.value?.features[change.pullRequest.number]?.source?.imageUrls[0]
            : null
          return (
            <DropdownMenuItem
              key={change.id}
              className="items-center whitespace-normal"
              onSelect={() => navigate(change.pullRequest?.number)}
            >
              <span className="flex w-full items-center gap-3 py-2">
                <span className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                  {preview ? (
                    <img
                      src={preview}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="size-full object-contain"
                    />
                  ) : (
                    <GitPullRequest className="size-4 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="line-clamp-2 block text-sm font-medium leading-snug">
                    {change.title}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {change.pullRequest ? `#${change.pullRequest.number} · ` : ''}
                    {t('community.includedInRunningBuild', 'Included in this build')}
                  </span>
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t('community.buildEntriesLinked', 'Included changes stay linked to their source.')}
        </div>
        <DropdownMenuItem asChild onSelect={() => navigate()}>
          <Button className="w-full justify-between">
            {t('community.manageCustom', 'Manage my Custom build')}
            <ArrowRight className="size-4" />
          </Button>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="mt-1 justify-center"
          onSelect={() => {
            setOpen(false)
            openCommunity()
          }}
        >
          {t('community.exploreProposals', 'Explore proposals')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
