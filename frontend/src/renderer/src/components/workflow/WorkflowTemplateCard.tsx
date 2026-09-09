import { Card, CardHeader, CardTitle, CardContent } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { WorkflowDefinition } from '@shared/workflow-types'

export function WorkflowTemplateCard({
  template,
  onUse,
  onPreview,
  onClone
}: {
  template: WorkflowDefinition
  onUse: () => void
  onPreview: () => void
  onClone: () => void
}) {
  return (
    <Card data-testid={`template-card-${template.id}`}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center justify-between">
          {template.name}
          <Badge variant="outline">{template.steps.length} steps</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" onClick={onUse} data-testid="template-use">
          Use
        </Button>
        <Button size="sm" variant="outline" onClick={onPreview} data-testid="template-preview">
          Preview
        </Button>
        <Button size="sm" variant="outline" onClick={onClone} data-testid="template-clone">
          Clone
        </Button>
      </CardContent>
    </Card>
  )
}
