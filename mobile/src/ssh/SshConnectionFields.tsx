import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { Network, Unplug } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import type { SshConnectionForm } from './ssh-connection-form'
import { sshConnectionStyles as styles } from './ssh-connection-styles'
import { colors } from '../theme/mobile-theme'
import type { SshProfile } from './ssh-profile'

export function SshConnectionFields(props: {
  form: SshConnectionForm
  disabled: boolean
  // The profile being edited, if any — it cannot jump to itself.
  selfId?: string
  // Other saved connections that can act as the jump host for this one.
  profiles: SshProfile[]
  change(field: keyof SshConnectionForm, value: string): void
  verify(): void
  importKey(): void
}) {
  function field(
    label: string,
    name: keyof SshConnectionForm,
    options?: { secret?: boolean; multiline?: boolean; numeric?: boolean }
  ) {
    return (
      <View key={name}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          style={styles.input}
          value={props.form[name]}
          onChangeText={(value) => props.change(name, value)}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          secureTextEntry={options?.secret}
          multiline={options?.multiline}
          keyboardType={options?.numeric ? 'number-pad' : 'default'}
          placeholderTextColor={colors.textMuted}
        />
      </View>
    )
  }
  return (
    <>
      {field('Name', 'name')}
      <Text style={styles.label}>Jump host (optional)</Text>
      <JumpHostSelector
        form={props.form}
        profiles={props.profiles}
        selfId={props.selfId}
        disabled={props.disabled}
        change={props.change}
      />
      {field('SSH hostname', 'host')}
      {field('SSH port', 'port', { numeric: true })}
      {field('SSH username', 'username')}
      <Text style={styles.help}>
        The SSH server opens this socket connection itself, so it resolves the hostname — use a name
        only that server knows.
      </Text>
      {field('Connect to host', 'targetHost')}
      {field('Connect to port (optional)', 'targetPort', { numeric: true })}
      {field('SSH host-key fingerprint', 'hostKeyFingerprint')}
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        style={styles.secondary}
        onPress={props.verify}
      >
        <Text style={styles.secondaryText}>Fetch and verify host key</Text>
      </Pressable>
      <View style={styles.segmented}>
        {(['password', 'key'] as const).map((mode) => {
          const active = props.form.auth === mode
          return (
            <Pressable
              key={mode}
              accessibilityRole="radio"
              aria-checked={active}
              disabled={props.disabled}
              onPress={() => props.change('auth', mode)}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {mode === 'password' ? 'Password' : 'Private key'}
              </Text>
            </Pressable>
          )
        })}
      </View>
      {props.form.auth === 'password' ? (
        field('SSH password', 'password', { secret: true })
      ) : (
        <>
          {field('SSH private key', 'privateKey', { multiline: true })}
          <Pressable
            accessibilityRole="button"
            disabled={props.disabled}
            style={styles.secondary}
            onPress={props.importKey}
          >
            <Text style={styles.secondaryText}>Import private key file</Text>
          </Pressable>
          {field('Private-key passphrase (optional)', 'passphrase', { secret: true })}
        </>
      )}
    </>
  )
}

function JumpHostSelector(props: {
  form: SshConnectionForm
  profiles: SshProfile[]
  selfId?: string
  disabled: boolean
  change(field: keyof SshConnectionForm, value: string): void
}) {
  const [open, setOpen] = useState(false)
  const selected = props.profiles.find((entry) => entry.id === props.form.jumpProfileId)
  const candidates = props.profiles.filter((entry) => entry.id !== props.selfId)
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Jump host"
        disabled={props.disabled || candidates.length === 0}
        style={styles.input}
        onPress={() => setOpen(true)}
      >
        <Text style={selected ? styles.profileName : styles.inputPlaceholder}>
          {selected
            ? `${selected.name} (${selected.username}@${selected.host}:${selected.port})`
            : candidates.length === 0
              ? 'Save another SSH connection first'
              : 'None — connect directly'}
        </Text>
      </Pressable>
      <ActionSheetModal
        visible={open}
        title="Jump host"
        message="Orca connects to this server first and lets it reach the SSH host."
        onClose={() => setOpen(false)}
        actions={[
          {
            label: 'None — connect directly',
            icon: Unplug,
            onPress: () => props.change('jumpProfileId', '')
          },
          ...candidates.map((entry) => ({
            label: `${entry.name} (${entry.username}@${entry.host}:${entry.port})`,
            icon: Network,
            onPress: () => props.change('jumpProfileId', entry.id)
          }))
        ]}
      />
    </>
  )
}
