import { useState } from 'react'
import { useTaskGrants } from '../../hooks/useTaskGrants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import type { RealGrantLevel } from '../../../../shared/task-types'

const GRANT_LEVELS: RealGrantLevel[] = ['owner', 'admin', 'user', 'team', 'company']

export function TaskGrantModal({ taskId }: { taskId: string }) {
  const { grants, addGrant, revoke, generateShareLink, isGranting } = useTaskGrants(taskId)
  const [subjectId, setSubjectId] = useState('')
  const [level, setLevel] = useState<RealGrantLevel>('user')
  const [applyTree, setApplyTree] = useState(false)

  return (
    <div className="task-grant-modal space-y-3" data-testid="task-grant-modal">
      <div>
        <p className="text-xs font-semibold mb-1">Current grants</p>
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No grant list available yet — pending backend `ListGrants` (BE-SOL-003).
          </p>
        ) : (
          grants.map((g) => (
            <div key={g.subjectId} className="flex items-center justify-between text-xs py-1">
              <span>
                {g.subjectId} — {g.level}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => revoke(g.subjectId)}
                data-testid={`revoke-${g.subjectId}`}
              >
                Revoke
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2 border-t pt-2">
        <p className="text-xs font-semibold">Add grant</p>
        <Input
          placeholder="User/Team/Company id..."
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          data-testid="grant-subject-input"
        />
        <Select value={level} onValueChange={(v) => setLevel(v as RealGrantLevel)}>
          <SelectTrigger data-testid="grant-level-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRANT_LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={applyTree}
            onChange={(e) => setApplyTree(e.target.checked)}
          />
          Apply to descendants
        </label>
        <Button
          size="sm"
          disabled={!subjectId.trim() || isGranting}
          onClick={() => addGrant(subjectId.trim(), level, applyTree)}
          data-testid="grant-submit"
        >
          {isGranting ? 'Granting...' : 'Grant access'}
        </Button>
      </div>

      <Button
        size="sm"
        variant="outline"
        onClick={generateShareLink}
        data-testid="grant-share-link"
      >
        Generate share link
      </Button>
    </div>
  )
}
