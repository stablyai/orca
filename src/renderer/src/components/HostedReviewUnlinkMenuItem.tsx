import type { JSX } from 'react'
import { Unlink } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type HostedReviewUnlinkMenuItemProps = {
  reviewLabel: string
  reviewIdentifier: string
  providerLabel: string
  disabled?: boolean
  onSelect: () => void
}

export function HostedReviewUnlinkMenuItem({
  reviewLabel,
  reviewIdentifier,
  providerLabel,
  disabled = false,
  onSelect
}: HostedReviewUnlinkMenuItemProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
          <Unlink className="size-3.5" />
          {translate(
            'auto.components.HostedReviewUnlinkMenuItem.label',
            'Unlink {{value0}} from workspace',
            { value0: reviewLabel }
          )}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-72 text-pretty">
        {translate(
          'auto.components.HostedReviewUnlinkMenuItem.description',
          'Orca will hide {{value0}} {{value1}} details for this workspace. The {{value0}} and branch on {{value2}} won’t be changed.',
          { value0: reviewLabel, value1: reviewIdentifier, value2: providerLabel }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
