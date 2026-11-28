// Import's "Add the folder it made": the bot's computer's folders, from Downloads, where the old bot saves its copy.
import { useEffect, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Folder, FolderOpen } from 'lucide-react-native'
import { MobileLoadErrorState, MobileStateView } from '../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import { readHostDirectory, type HostDirectory } from './bot-import-host-reads'

/** A folder picked on the bot's computer: its path there, how it reads with `~`, and what's in it. */
export type ExportFolder = { path: string; shown: string; count: number }

function shownEntries(directory: HostDirectory) {
  return directory.entries.filter((entry) => !entry.name.startsWith('.'))
}

function childPath(directory: HostDirectory, name: string): string {
  const separator = directory.pathFlavor === 'win32' ? '\\' : '/'
  return directory.resolvedPath.endsWith(separator)
    ? `${directory.resolvedPath}${name}`
    : `${directory.resolvedPath}${separator}${name}`
}

/** "/Users/k/Downloads/sage-export" as "~/Downloads/sage-export". */
export function homeRelativePath(path: string, home: string | null): string {
  return home && path.startsWith(home) && path !== home ? `~${path.slice(home.length)}` : path
}

export function MobileBotExportFolderPage(props: {
  client: RpcClient | null
  hostLabel: string
  onBack: () => void
  onPick: (folder: ExportFolder) => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const { client } = props
  // Home first, so Back from Downloads reaches the rest of it; the last one shows.
  const [stack, setStack] = useState<HostDirectory[]>([])
  // `folder` is the subfolder that failed to open, which Retry opens again.
  const [failure, setFailure] = useState<{ error: unknown; folder?: string } | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Back past a folder still opening drops its answer.
  const navigation = useRef(0)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    setFailure(null)
    readHostDirectory(client, '~').then(
      async (home) => {
        const downloads = await readHostDirectory(client, childPath(home, 'Downloads')).catch(
          () => null
        )
        if (live) {
          setStack(downloads ? [home, downloads] : [home])
        }
      },
      (error: unknown) => live && setFailure({ error })
    )
    return () => {
      live = false
    }
  }, [client, attempt])

  const home = stack[0]?.resolvedPath ?? null
  const current = stack.at(-1)
  const back = () => {
    navigation.current += 1
    setOpening(null)
    setFailure(null)
    if (stack.length > 1) {
      setStack(stack.slice(0, -1))
    } else {
      props.onBack()
    }
  }
  const open = async (name: string) => {
    if (!client || !current || opening) {
      return
    }
    const at = ++navigation.current
    setOpening(name)
    try {
      const next = await readHostDirectory(client, childPath(current, name))
      if (at === navigation.current) {
        setStack([...stack, next])
      }
    } catch (error) {
      if (at === navigation.current) {
        setFailure({ error, folder: name })
      }
    } finally {
      if (at === navigation.current) {
        setOpening(null)
      }
    }
  }
  const entries = current ? shownEntries(current) : []
  // Only folders can be picked; a Downloads full of files would cost a row each.
  const folders = entries.filter((entry) => entry.isDirectory)

  return (
    <View style={styles.page}>
      <SheetHeader
        title={
          current
            ? current.resolvedPath === home
              ? '~'
              : getRuntimePathBasename(current.resolvedPath)
            : t('bots.import.chooseFolderTitle', 'Choose a folder')
        }
        subtitle={t('bots.import.onHost', 'On {{host}}', { host: props.hostLabel })}
        onBack={{ label: t('common.back', 'Back'), onPress: back }}
      />
      {failure ? (
        <MobileLoadErrorState
          error={failure.error}
          onRetry={() => {
            setFailure(null)
            if (failure.folder) {
              void open(failure.folder)
            } else if (!current) {
              setAttempt(attempt + 1)
            }
          }}
        />
      ) : !current ? (
        <MobileStateView loading title={t('bots.import.loadingFolders', 'Loading folders…')} />
      ) : (
        <>
          <ScrollView style={styles.page} showsVerticalScrollIndicator={false}>
            {folders.length === 0 ? (
              <MobileStateView icon={FolderOpen} title={t('bots.import.noFolders', 'No folders')} />
            ) : (
              <ListGroup separatorInset={LIST_LEADING_INSET}>
                {folders.map((entry) => (
                  <ListRow
                    key={entry.name}
                    leading={<Folder size={18} color={colors.textSecondary} />}
                    title={entry.name}
                    navigates
                    busy={opening === entry.name}
                    onPress={() => void open(entry.name)}
                  />
                ))}
              </ListGroup>
            )}
          </ScrollView>
          <View style={styles.foot}>
            <SheetPrimaryButton
              label={t('bots.import.selectFolder', 'Select folder')}
              disabled={opening !== null}
              onPress={() =>
                props.onPick({
                  path: current.resolvedPath,
                  shown: homeRelativePath(current.resolvedPath, home),
                  count: entries.length
                })
              }
            />
          </View>
        </>
      )}
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  page: { flex: 1 },
  foot: { paddingTop: spacing.md }
}))
