import { useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { FolderOpen, FolderPlus, Globe, Plus } from 'lucide-react-native'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import type { RpcClient } from '../transport/rpc-client'
import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'
import {
  CloneProjectForm,
  CreateProjectForm,
  ExistingProjectForm,
  type BrowseTarget
} from './AddProjectForms'
import type { AddedProject } from './add-project-reply-schema'
import { addProjectStyles as styles } from './add-project-styles'
import { useAddProjectFlow } from './use-add-project-flow'

type Props = {
  visible: boolean
  client: RpcClient | null
  onClose: () => void
  /** Opened after this sheet has gone, so two native sheets never stack; `repoId` preselects a just-added project. */
  onNewWorkspace: (repoId?: string) => void
  onProjectAdded: (project: AddedProject) => void
}

export function AddProjectSheet({
  visible,
  client,
  onClose,
  onNewWorkspace,
  onProjectAdded
}: Props) {
  const flow = useAddProjectFlow({ client, visible, onProjectAdded })
  const [browsing, setBrowsing] = useState<BrowseTarget | null>(null)
  const afterCloseRef = useRef<(() => void) | null>(null)

  const closeThen = (next: () => void) => {
    afterCloseRef.current = next
    onClose()
  }
  const back = () => flow.openStep('choose')

  let content
  if (browsing && client) {
    content = (
      <AddProjectFolderBrowser
        client={client}
        startPath={browsing === 'parent' ? flow.parent : flow.existingPath}
        pickLabel={browsing === 'parent' ? 'Use this location' : 'Use this folder'}
        onBack={() => setBrowsing(null)}
        onPick={(path) => {
          if (browsing === 'parent') {
            flow.setParent(path)
          } else {
            flow.setExistingPath(path)
          }
          setBrowsing(null)
        }}
      />
    )
  } else if (flow.step === 'create') {
    content = <CreateProjectForm flow={flow} onBack={back} onBrowse={setBrowsing} />
  } else if (flow.step === 'clone') {
    content = <CloneProjectForm flow={flow} onBack={back} onBrowse={setBrowsing} />
  } else if (flow.step === 'existing') {
    content = <ExistingProjectForm flow={flow} onBack={back} onBrowse={setBrowsing} />
  } else if (flow.step === 'added' && flow.added) {
    const added = flow.added
    // Folder projects are their own workspace, so only Git projects get a first-workspace prompt.
    const isGit = added.kind !== 'folder'
    content = (
      <View>
        <Text style={styles.title}>Project added</Text>
        <Text style={styles.message} numberOfLines={2}>
          {`${added.displayName} · ${added.path}`}
        </Text>
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.cancelButton, pressed && styles.buttonPressed]}
            onPress={onClose}
          >
            <Text style={styles.cancelText}>Done</Text>
          </Pressable>
          {isGit ? (
            <Pressable
              style={({ pressed }) => [styles.submitButton, pressed && styles.buttonPressed]}
              onPress={() => closeThen(() => onNewWorkspace(added.id))}
            >
              <Text style={styles.submitText}>Create workspace</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    )
  } else {
    content = (
      <ActionSheetContent
        title="Create"
        actions={[
          {
            label: 'New workspace',
            icon: Plus,
            hint: 'In a project already on this host',
            skipAutoClose: true,
            onPress: () => closeThen(() => onNewWorkspace())
          },
          {
            label: 'New project',
            icon: FolderPlus,
            hint: 'Create an empty repository on the host',
            skipAutoClose: true,
            onPress: () => flow.openStep('create')
          },
          {
            label: 'Clone repository',
            icon: Globe,
            hint: flow.gitAvailable ? 'From a Git URL' : 'Git was not found on the host',
            disabled: !flow.gitAvailable,
            skipAutoClose: true,
            onPress: () => flow.openStep('clone')
          },
          {
            label: 'Add existing folder',
            icon: FolderOpen,
            hint: 'A project or folder already on the host',
            skipAutoClose: true,
            onPress: () => flow.openStep('existing')
          }
        ]}
      />
    )
  }

  return (
    <BottomDrawer
      visible={visible}
      onClose={() => {
        // A running clone keeps going on the host; closing only stops this sheet waiting for it.
        setBrowsing(null)
        onClose()
      }}
      onAfterClose={() => {
        const next = afterCloseRef.current
        afterCloseRef.current = null
        next?.()
      }}
      // The drawer cannot see the folder list's own scroll offset, so scrolling it would read as a dismiss drag.
      dragContentToDismiss={!browsing}
    >
      {content}
    </BottomDrawer>
  )
}
