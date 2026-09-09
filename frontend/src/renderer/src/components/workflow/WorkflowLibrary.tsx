import { useState } from 'react'
import { useWorkflowLibrary, type LibraryScope } from '../../hooks/useWorkflowLibrary'
import { WorkflowTemplateCard } from './WorkflowTemplateCard'
import { Input } from '../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

export function WorkflowLibrary({
  onUseTemplate
}: {
  onUseTemplate: (templateId: string) => void
}) {
  const [scope, setScope] = useState<LibraryScope>('company')
  const [search, setSearch] = useState('')
  const { templates, loading, loadError } = useWorkflowLibrary(scope, search)

  return (
    <div className="workflow-library space-y-3 p-2" data-testid="workflow-library">
      <Input
        placeholder="Search templates..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="library-search"
      />
      <Tabs value={scope} onValueChange={(v) => setScope(v as LibraryScope)}>
        <TabsList>
          <TabsTrigger value="company">Company Standards</TabsTrigger>
          <TabsTrigger value="team">Team Templates</TabsTrigger>
          <TabsTrigger value="personal">My Workflows</TabsTrigger>
        </TabsList>
      </Tabs>
      {loading ? (
        <div className="text-xs text-muted-foreground" data-testid="library-loading">
          Loading...
        </div>
      ) : loadError ? (
        <div className="text-xs text-destructive" data-testid="library-error">
          Failed to load templates.
        </div>
      ) : templates.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="library-empty">
          No templates in this scope yet.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {templates.map((t) => (
            <WorkflowTemplateCard
              key={t.id}
              template={t}
              onUse={() => onUseTemplate(t.id)}
              onPreview={() => {}}
              onClone={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  )
}
