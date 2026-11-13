import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { getCustomBuildInfo } from '../../../shared/custom-build'
import { openCommunity } from '@/components/community/community-navigation'
export function CustomBuildBadge(): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const build = getCustomBuildInfo()
  if (!build) {
    return null
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="mx-1 [-webkit-app-region:no-drag]"
          aria-label={t('community.customDetails', 'Custom build details')}
        >
          {t('community.customLabel', 'Custom')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('community.myCustom', 'My Custom build')}</h2>
          <Badge variant="outline">
            {build.profileMode === 'shared-profile'
              ? t('community.sharedProfile', 'Shared profile')
              : t('community.previewBuild', 'Preview')}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('community.basedOn', 'Based on official Orca')} {build.baseVersion}
        </p>
        <ul className="my-3 divide-y divide-border">
          {build.changes.slice(0, 4).map((change) => (
            <li key={change.id} className="flex items-center gap-2 py-2 text-xs">
              <FlaskConical className="size-3 shrink-0 text-muted-foreground" />
              {change.title}
            </li>
          ))}
        </ul>
        <Button
          className="w-full"
          onClick={() => {
            setOpen(false)
            openCommunity('custom')
          }}
        >
          {t('community.manageCustom', 'Manage my Custom build')} · {build.changes.length}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
