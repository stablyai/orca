import type {
  ItsaplanIssue,
  ItsaplanIssueDetail,
  ItsaplanProjectMetadata
} from '../../../shared/itsaplan/itsaplan-types'
import { defineFixture } from '../component-fixtures/component-fixture'
import ItsaplanIssueWorkspace from './ItsaplanIssueWorkspace'

const issue: ItsaplanIssue = {
  id: 4201,
  identifier: 'ENG-42',
  sequenceNumber: 42,
  projectRef: 'acme.ENG',
  title: 'Retry webhook deliveries with exponential backoff',
  description:
    'Deliveries that fail with a 5xx are dropped today.\n\n- Retry up to **5** times\n- Back off from 1s to 5m\n- Record each attempt',
  priority: 'high',
  state: { columnId: 2, name: 'In progress', stateType: 'started' },
  labels: [
    { id: 1, name: 'backend', color: null },
    { id: 2, name: 'reliability', color: null }
  ],
  assignee: { userId: 'u1', name: 'Ada Lovelace', isAgent: false },
  delegate: { userId: 'agent-1', name: 'Build agent', isAgent: true },
  parentId: null,
  url: 'https://plan.example.com/issue/4201',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z'
}

const detail: ItsaplanIssueDetail = {
  ...issue,
  subtasks: [
    {
      ...issue,
      id: 4210,
      identifier: 'ENG-50',
      sequenceNumber: 50,
      title: 'Add the retry queue table',
      parentId: issue.id,
      state: { columnId: 3, name: 'Done', stateType: 'completed' }
    },
    {
      ...issue,
      id: 4211,
      identifier: 'ENG-51',
      sequenceNumber: 51,
      title: 'Expose attempts in the delivery log',
      parentId: issue.id,
      state: { columnId: 1, name: 'Todo', stateType: 'unstarted' }
    }
  ],
  comments: [
    {
      id: 1,
      body: 'Should we cap the total retry window at one hour?',
      author: { userId: 'u2', name: 'Grace Hopper' },
      createdAt: '2026-11-24T09:00:00.000Z'
    }
  ]
}

const metadata: ItsaplanProjectMetadata = {
  project: { id: 7, ref: 'acme.ENG', key: 'ENG', name: 'Engineering' },
  columns: [
    { id: 1, name: 'Todo', stateType: 'unstarted', position: 1 },
    { id: 2, name: 'In progress', stateType: 'started', position: 2 },
    { id: 3, name: 'Done', stateType: 'completed', position: 3 }
  ],
  labels: issue.labels,
  members: [
    { userId: 'u1', name: 'Ada Lovelace', isAgent: false },
    { userId: 'u2', name: 'Grace Hopper', isAgent: false }
  ]
}

export const detailPage = defineFixture({
  width: 1200,
  store: {
    itsaplanIssueDetails: { [issue.id]: detail },
    itsaplanProjectMetadata: { [metadata.project.ref]: metadata },
    loadItsaplanIssueDetail: async () => detail,
    loadItsaplanProjectMetadata: async () => metadata
  },
  render: () => (
    <div className="h-[760px] bg-background p-2">
      <ItsaplanIssueWorkspace
        issue={issue}
        backLabel="It's a Plan list"
        onUse={() => {}}
        onOpenIssue={() => {}}
        onClose={() => {}}
        onReconnect={() => {}}
      />
    </div>
  )
})
