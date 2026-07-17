import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { assertWindowsOpenSshWorkflow } from './ssh-relay-runtime-windows-openssh-workflow-contract.mjs'

const workflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-artifacts.yml',
  import.meta.url
)
const linuxBuilderUrl = new URL('../ssh-relay-runtime-linux-builder.Containerfile', import.meta.url)

function normalizeCheckoutNewlines(source) {
  return source.replaceAll('\r\n', '\n')
}

describe('SSH relay runtime artifact workflow', () => {
  it('normalizes Windows checkout newlines for text contracts', () => {
    expect(normalizeCheckoutNewlines('first\r\nsecond\r\n')).toBe('first\nsecond\n')
  })

  it('uses exact native runner labels and SHA-pinned actions without publication authority', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'))
    const posixJob = workflow.jobs['build-posix-runtime']
    const windowsJob = workflow.jobs['build-windows-runtime']

    expect(posixJob.strategy.matrix.include.map((entry) => [entry.runner, entry.tuple])).toEqual([
      ['ubuntu-24.04', 'linux-x64-glibc'],
      ['ubuntu-24.04-arm', 'linux-arm64-glibc'],
      ['macos-15-intel', 'darwin-x64'],
      ['macos-15', 'darwin-arm64']
    ])
    expect(
      posixJob.strategy.matrix.include.slice(0, 2).map((entry) => entry.container_image)
    ).toEqual([
      'docker.io/library/rockylinux@sha256:2d05a9266523bbf24f33ebc3a9832e4d5fd74b973c220f2204ca802286aa275d',
      'docker.io/library/rockylinux@sha256:3c2d0ce12bf79fc5ff05e43b1000e30ff062dc89405525f3307cbff71661f1a0'
    ])
    expect(windowsJob.strategy.matrix.include.map((entry) => [entry.runner, entry.tuple])).toEqual([
      ['windows-2022', 'win32-x64'],
      ['windows-11-arm', 'win32-arm64']
    ])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(posixJob['timeout-minutes']).toBe(20)
    expect(windowsJob['timeout-minutes']).toBe(30)
    for (const job of [posixJob, windowsJob]) {
      expect(job.env.ORCA_RUNTIME_REQUESTED_RUNNER).toBe('${{ matrix.runner }}')
      expect(job.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}')
      for (const step of job.steps.filter((candidate) => candidate.uses)) {
        expect(step.uses).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/)
      }
    }
  })

  it('bounds hosted Linux prerequisite acquisition over HTTPS', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'))
    const installStep = workflow.jobs['build-posix-runtime'].steps.find(
      (step) => step.name === 'Install Linux build and verification tools'
    )
    const missingGate = 'if ((${#missing_requirements[@]} > 0)); then'

    expect(installStep.run).toContain(
      'required_commands=(cc c++ make ar ld strip curl gpg gpgv python3 xz)'
    )
    expect(installStep.run).toContain('missing_requirements+=(ca-certificates)')
    expect(installStep.run).toContain(missingGate)
    expect(installStep.run.indexOf('if ! probe_c_toolchain')).toBeLessThan(
      installStep.run.indexOf(missingGate)
    )
    expect(installStep.run.indexOf('sudo sed -i')).toBeGreaterThan(
      installStep.run.indexOf(missingGate)
    )
    expect(installStep.run).toContain("'s|http://ports.ubuntu.com|https://ports.ubuntu.com|g'")
    expect(installStep.run).toContain('Acquire::Retries=3')
    expect(installStep.run).toContain('Acquire::https::Timeout=15')
    expect(installStep.run).toContain('Acquire::ForceIPv4=true')
    expect(
      installStep.run.match(/timeout --signal=TERM --kill-after=15s 180s sudo apt-get/g)
    ).toHaveLength(2)
    expect(installStep.run).toContain('orca-ci-c-probe')
    expect(installStep.run).toContain('orca-ci-cxx-probe')
    expect(installStep.run.lastIndexOf('probe_cxx_toolchain')).toBeGreaterThan(
      installStep.run.indexOf(missingGate)
    )
  })

  it('runs exact full-size Linux runtime transfer against loopback-only stock OpenSSH', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'))
    const steps = workflow.jobs['build-posix-runtime'].steps
    const start = steps.find((step) => step.name === 'Start loopback OpenSSH SFTP fixture')
    const measure = steps.find(
      (step) => step.name === 'Measure exact full-size runtime over live OpenSSH SFTP'
    )
    const stop = steps.find((step) => step.name === 'Stop loopback OpenSSH SFTP fixture')

    expect(start.if).toBe("runner.os == 'Linux'")
    expect(start.run).toContain('ListenAddress 127.0.0.1')
    expect(start.run).toContain('Subsystem sftp internal-sftp')
    expect(start.run).toContain('sudo usermod --password')
    expect(start.run).toContain('PasswordAuthentication no')
    expect(start.run).toContain('timeout --signal=TERM --kill-after=15s 180s sudo apt-get')
    expect(measure.if).toBe("runner.os == 'Linux'")
    expect(measure.run).toContain('ssh-relay-runtime-sftp-openssh-full-size.test.ts')
    expect(measure.run).toContain('first_output/runtime')
    expect(stop.if).toBe("always() && runner.os == 'Linux'")
  })

  it('runs full-size POSIX system SSH against loopback OpenSSH with restricted primitives', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'))
    const steps = workflow.jobs['build-posix-runtime'].steps
    const start = steps.find(
      (step) => step.name === 'Start restricted loopback OpenSSH POSIX system-SSH fixture'
    )
    const measure = steps.find(
      (step) => step.name === 'Measure exact full-size runtime over POSIX system SSH'
    )
    const stop = steps.find(
      (step) => step.name === 'Stop restricted loopback OpenSSH POSIX system-SSH fixture'
    )

    expect(start).toBeDefined()
    expect(measure).toBeDefined()
    expect(stop).toBeDefined()
    expect(start.if).toBe("runner.os == 'Linux'")
    expect(start.run).toContain('ListenAddress 127.0.0.1')
    expect(start.run).toContain('ForceCommand $wrapper')
    expect(start.run).toContain('PasswordAuthentication no')
    expect(start.run).toContain('StrictModes yes')
    expect(start.run).toContain('known_hosts')
    expect(start.run).toContain('StrictHostKeyChecking=yes')
    for (const primitive of ['mkdir', 'chmod', 'cat', 'rm']) {
      expect(start.run).toContain(`command -v ${primitive}`)
    }
    for (const forbidden of ['node', 'python', 'perl', 'tar', 'base64', 'sha256sum', 'shasum']) {
      expect(start.run).not.toContain(`command -v ${forbidden}`)
    }
    expect(measure.if).toBe("runner.os == 'Linux'")
    expect(measure.run).toContain('ORCA_SSH_FORCE_SYSTEM_TRANSPORT=1')
    expect(measure.run).toContain('ssh-relay-runtime-posix-system-ssh-openssh-full-size.test.ts')
    expect(measure.run).toContain('first_output/runtime')
    expect(stop.if).toBe("always() && runner.os == 'Linux'")
  })

  it('runs full-size Windows system SSH against loopback native OpenSSH', async () => {
    const [workflowSource, fullSizeSource, connectionSource, managerSource] = await Promise.all([
      readFile(workflowUrl, 'utf8'),
      readFile(
        new URL(
          '../../src/main/ssh/ssh-relay-runtime-windows-system-ssh-openssh-full-size.test.ts',
          import.meta.url
        ),
        'utf8'
      ),
      readFile(new URL('../../src/main/ssh/ssh-connection.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/ssh/ssh-connection-manager.ts', import.meta.url), 'utf8')
    ])
    const workflow = parse(workflowSource)
    assertWindowsOpenSshWorkflow(workflow, expect)
    expect(fullSizeSource).toContain('process.env.ORCA_SSH_WINDOWS_NO_INPUT_LAUNCHER')
    expect(fullSizeSource).toContain('windowsNoInputLauncherPath: launcherPath as string')
    expect(fullSizeSource).toContain(
      "strictKnownHostsFile: join(clientHome as string, '.ssh', 'known_hosts')"
    )
    expect(connectionSource).not.toContain('ORCA_SSH_WINDOWS_NO_INPUT_LAUNCHER')
    expect(connectionSource).not.toContain('ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_CLIENT_HOME')
    expect(managerSource).not.toContain('windowsNoInputLauncherPath')
    expect(managerSource).not.toContain('strictKnownHostsFile')
  })

  it('uploads only the first output after two clean builds verify and compare', async () => {
    const source = await readFile(workflowUrl, 'utf8')
    const workflow = parse(source)
    const steps = workflow.jobs['build-posix-runtime'].steps
    const windowsSteps = workflow.jobs['build-windows-runtime'].steps
    const buildIndex = steps.findIndex(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    )
    const uploadIndex = steps.findIndex(
      (step) => step.name === 'Upload unpublished artifact evidence'
    )
    const measurementIndex = steps.findIndex(
      (step) => step.name === 'Measure full-size desktop extraction and cache boundaries'
    )
    const windowsBuildIndex = windowsSteps.findIndex(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    )
    const windowsMeasurementIndex = windowsSteps.findIndex(
      (step) => step.name === 'Measure full-size desktop extraction and cache boundaries'
    )
    const windowsUploadIndex = windowsSteps.findIndex(
      (step) => step.name === 'Upload unpublished artifact evidence'
    )

    expect(buildIndex).toBeGreaterThan(-1)
    expect(windowsBuildIndex).toBeGreaterThan(-1)
    expect(measurementIndex).toBeGreaterThan(buildIndex)
    expect(uploadIndex).toBeGreaterThan(measurementIndex)
    expect(windowsMeasurementIndex).toBeGreaterThan(windowsBuildIndex)
    expect(windowsUploadIndex).toBeGreaterThan(windowsMeasurementIndex)
    expect(source).toContain('verify-ssh-relay-runtime.mjs')
    expect(source).toContain('ssh-relay-runtime-workflow.test.mjs')
    expect(
      source.match(/node --check config\/scripts\/build-windows-ssh-no-input-launcher\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(/config\/scripts\/ssh-relay-runtime-windows-no-input-launcher\.test\.mjs/g)
    ).toHaveLength(4)
    for (const testName of [
      'ssh-relay-artifact-schema.test.ts',
      'ssh-relay-manifest-signature.test.ts',
      'ssh-relay-release-asset.test.ts',
      'ssh-relay-artifact-selector.test.ts',
      'ssh-relay-libc-detection.test.ts',
      'ssh-relay-linux-kernel-detection.test.ts',
      'ssh-relay-host-evidence-detection.test.ts',
      'ssh-relay-darwin-version-detection.test.ts',
      'ssh-relay-darwin-translation-detection.test.ts',
      'ssh-relay-linux-libstdcxx-detection.test.ts',
      'ssh-relay-windows-compatibility-detection.test.ts',
      'ssh-relay-artifact-download.test.ts',
      'ssh-relay-artifact-extraction.test.ts',
      'ssh-relay-artifact-cache-lock-release.test.ts',
      'ssh-relay-artifact-cache-lock.test.ts',
      'ssh-relay-artifact-cache-entry.test.ts',
      'ssh-relay-artifact-cache-in-use-lease.test.ts',
      'ssh-relay-artifact-cache-eviction.test.ts',
      'ssh-relay-artifact-cache-root.test.ts',
      'ssh-relay-artifact-cache-resolution.test.ts',
      'ssh-relay-artifact-cache-population.test.ts',
      'ssh-relay-artifact-cache-population-integration.test.ts',
      'ssh-relay-artifact-acquisition.test.ts',
      'ssh-relay-artifact-acquisition-integration.test.ts',
      'ssh-relay-runtime-source-tree.test.ts',
      'ssh-relay-runtime-source-scan.test.ts',
      'ssh-relay-runtime-source-stream.test.ts',
      'ssh-relay-runtime-posix-control-command.test.ts',
      'ssh-relay-runtime-posix-file-destination.test.ts',
      'ssh-relay-runtime-windows-file-destination.test.ts',
      'ssh-relay-runtime-windows-staging-control.test.ts',
      'ssh-relay-runtime-windows-tree-transfer.test.ts',
      'ssh-relay-runtime-posix-tree-transfer.test.ts',
      'ssh-relay-runtime-system-ssh-file-channel.test.ts',
      'ssh-relay-runtime-sftp-file-destination.test.ts',
      'ssh-relay-runtime-sftp-connection-transfer.test.ts',
      'ssh-relay-runtime-sftp-session.test.ts',
      'ssh-relay-runtime-sftp-tree-transfer.test.ts',
      'ssh-relay-compiled-manifest-trust.test.ts',
      'ssh-relay-official-manifest.test.ts',
      'ssh-relay-manifest-accepted-keys.test.ts',
      'ssh-relay-packaged-manifest.test.ts',
      'ssh-relay-runtime-identity.test.ts'
    ]) {
      // Why: portable desktop selection contracts need proof on every native runner family, not
      // only the local client architecture or the generic Linux PR job.
      expect(source.split(`src/main/ssh/${testName}`)).toHaveLength(3)
    }
    expect(
      source.split('src/main/ssh/ssh-relay-artifact-extraction-full-size.test.ts')
    ).toHaveLength(3)
    expect(
      source.split('src/main/ssh/ssh-relay-artifact-cache-entry-full-size.test.ts')
    ).toHaveLength(3)
    expect(source).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(source).toContain('--connect-timeout 20 --max-time 300 --retry 2')
    expect(source).toContain('mkdir -p "$output_root"')
    expect(source).toContain('source_commit=$(git rev-parse HEAD)')
    expect(source).toContain('--git-commit "$source_commit"')
    expect(source).not.toContain('--git-commit "$GITHUB_SHA"')
    expect(source).toContain('for output in "$first_output" "$second_output"')
    expect(source).toContain('foreach ($output in @($firstOutput, $secondOutput))')
    expect(source).toContain('ssh-relay-runtime-reproducibility.mjs')
    expect(source).toContain('ssh-relay-runtime-reproducibility.test.mjs')
    expect(source.match(/ssh-relay-runtime-closure\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-sbom\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-provenance\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-toolchain\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-native-signing-plan\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-native-signing-selection\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-native-signing-payload\.test\.mjs/g)).toHaveLength(4)
    expect(
      source.match(/ssh-relay-runtime-windows-authenticode-assessment\.test\.mjs/g)
    ).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-native-signing-stage\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-native-signing-apply\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/ssh-relay-runtime-macos-signature-verification\.test\.mjs/g)).toHaveLength(
      4
    )
    expect(
      source.match(/ssh-relay-runtime-windows-signature-verification\.test\.mjs/g)
    ).toHaveLength(4)
    for (const moduleName of [
      'compatibility',
      'windows-source-signature-verification',
      'release-stage-gate',
      'draft-recovery',
      'aggregate-input',
      'draft-readback',
      'draft-upload',
      'release-assets'
    ]) {
      const script = `ssh-relay-runtime-${moduleName}`
      expect(source.split(`${script}.test.mjs`)).toHaveLength(5)
      expect(source.split(`node --check config/scripts/${script}.mjs`)).toHaveLength(3)
    }
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-manifest-validation\.mjs/g)
    ).toHaveLength(2)
    for (const moduleName of [
      'manifest-assembly',
      'manifest-signing-handoff',
      'manifest-aggregate',
      'manifest-tuple',
      'post-sign-metadata',
      'archive-extraction',
      'macos-signing',
      'native-signing-finalization'
    ]) {
      const script = `ssh-relay-runtime-${moduleName}`
      expect(source.split(`${script}.test.mjs`)).toHaveLength(5)
      expect(source.split(`node --check config/scripts/${script}.mjs`)).toHaveLength(3)
    }
    expect(
      source.match(
        /node --check config\/scripts\/ssh-relay-runtime-native-signing-stage-report\.mjs/g
      )
    ).toHaveLength(2)
    expect(source.match(/ssh-relay-runtime-native-signing-workflow\.test\.mjs/g)).toHaveLength(4)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-native-signing-plan\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-native-signing-selection\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-native-signing-payload\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(
        /node --check config\/scripts\/ssh-relay-runtime-windows-authenticode-assessment\.mjs/g
      )
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-native-signing-stage\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-native-signing-apply\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(
        /node --check config\/scripts\/ssh-relay-runtime-macos-signature-verification\.mjs/g
      )
    ).toHaveLength(2)
    expect(
      source.match(
        /node --check config\/scripts\/ssh-relay-runtime-windows-signature-verification\.mjs/g
      )
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-closure\.mjs/g)
    ).toHaveLength(2)
    expect(source).toContain('ssh-relay-runtime-windows-pe-diagnostic.mjs')
    expect(source).toContain('ssh-relay-runtime-windows-pe-diagnostic.test.mjs')
    expect(source).toContain('llvm-objdump.exe')
    expect(source).toContain('--start-address=0x180001000 --stop-address=0x180001200')
    expect(source).toContain(
      'node --check config/scripts/ssh-relay-runtime-reproducibility.test.mjs'
    )
    expect(
      source.match(/node --check config\/scripts\/build-ssh-relay-runtime\.mjs/g)
    ).toHaveLength(2)
    expect(
      source.match(/node --check config\/scripts\/ssh-relay-runtime-build\.test\.mjs/g)
    ).toHaveLength(2)
    expect(source.match(/ssh-relay-node-pty-build\.test\.mjs/g)).toHaveLength(2)
    expect(source.match(/ssh-relay-node-pty-windows-build-determinism\.test\.mjs/g)).toHaveLength(2)
    expect(source.match(/ssh-relay-runtime-build\.test\.mjs/g)).toHaveLength(4)
    expect(source.match(/--work-directory/g)).toHaveLength(3)
    expect(source).toContain('work_directory="$RUNNER_TEMP/orca-ssh-relay-runtime-build-work"')
    expect(source).toContain(
      "$workDirectory = Join-Path $env:RUNNER_TEMP 'orca-ssh-relay-runtime-build-work'"
    )
    expect(source).not.toContain('work_directory="$output_root/build-work"')
    expect(source).not.toContain("Join-Path $outputRoot 'build-work'")
    expect(source).toContain('cp "$first_output"/*.tar.br')
    expect(source).toContain("-name '*.tar.br'")
    expect(source).not.toContain('tar -xJf "$archive"')
    expect(source.match(/ssh-relay-runtime-portable-archive\.test\.mjs/g)).toHaveLength(4)
    expect(source).toContain("Get-ChildItem -LiteralPath $firstOutput -Filter '*.zip'")
    expect(source).toContain('ssh-relay-node-zip-inspection.test.mjs')
    expect(source).toContain('ssh-relay-runtime-pty-smoke.test.mjs')
    expect(source).toContain('ssh-relay-runtime-resource-diagnostics.test.mjs')
    expect(source).toContain('ssh-relay-runtime-zip.test.mjs')
    expect(source).toContain('node-v24.18.0-headers.tar.gz')
    expect(source).toContain('node_library: win-x64/node.lib')
    expect(source).toContain("@('gpg.exe', 'gpgv.exe')")
    for (const jobSteps of [steps, windowsSteps]) {
      const run = jobSteps.find(
        (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
      ).run
      expect(run.indexOf('ssh-relay-runtime-reproducibility.mjs')).toBeGreaterThan(
        run.indexOf('verify-ssh-relay-runtime.mjs')
      )
      expect(run.lastIndexOf('runtime-evidence/${{ matrix.tuple }}')).toBeGreaterThan(
        run.indexOf('ssh-relay-runtime-reproducibility.mjs')
      )
    }
    const windowsRun = windowsSteps.find(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    ).run
    expect(windowsRun.indexOf('ssh-relay-runtime-windows-pe-diagnostic.mjs')).toBeGreaterThan(
      windowsRun.indexOf('ssh-relay-runtime-reproducibility.mjs')
    )
    expect(windowsRun.indexOf('llvm-objdump.exe')).toBeGreaterThan(
      windowsRun.indexOf('ssh-relay-runtime-windows-pe-diagnostic.mjs')
    )
    expect(
      windowsRun.indexOf("throw 'runtime reproducibility verification failed'")
    ).toBeGreaterThan(windowsRun.indexOf('llvm-objdump.exe'))
    expect(windowsRun.indexOf('runtime-evidence/${{ matrix.tuple }}')).toBeGreaterThan(
      windowsRun.indexOf("throw 'runtime reproducibility verification failed'")
    )
    expect(steps[uploadIndex].with.path).toBe('runtime-evidence/${{ matrix.tuple }}/')
    expect(source).not.toMatch(
      /github\.com\/stablyai\/orca\/releases\/|gh release|contents:\s*write/i
    )
  })

  it('assesses and stages real first-build candidates without signing authority', async () => {
    const source = await readFile(workflowUrl, 'utf8')
    const workflow = parse(source)
    const posixRun = workflow.jobs['build-posix-runtime'].steps.find(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    ).run
    const windowsRun = workflow.jobs['build-windows-runtime'].steps.find(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    ).run

    expect(posixRun.match(/ssh-relay-runtime-native-signing-stage\.mjs/g)).toHaveLength(2)
    expect(windowsRun.match(/ssh-relay-runtime-native-signing-stage\.mjs/g)).toHaveLength(1)
    expect(posixRun.indexOf('ssh-relay-runtime-native-signing-stage.mjs')).toBeGreaterThan(
      posixRun.indexOf('ssh-relay-runtime-linux-build-evidence.mjs')
    )
    expect(posixRun.lastIndexOf('ssh-relay-runtime-native-signing-stage.mjs')).toBeGreaterThan(
      posixRun.indexOf('ssh-relay-runtime-reproducibility.mjs')
    )
    expect(windowsRun.indexOf('ssh-relay-runtime-native-signing-stage.mjs')).toBeGreaterThan(
      windowsRun.indexOf('ssh-relay-runtime-reproducibility.mjs')
    )
    expect(posixRun).toContain('Linux signing-stage report violates the hash-only contract')
    expect(posixRun).toContain('macOS signing-stage report violates the Developer ID contract')
    expect(posixRun).toContain('test ! -e "$signing_stage/bin/node"')
    expect(windowsRun).toContain('Windows signing-stage report violates the Authenticode contract')
    expect(windowsRun).toContain('@($report.signingFiles).Count -ne 3')
    expect(windowsRun).toContain('@($report.preservedUpstreamFiles).Count -ne 2')
    expect(windowsRun).toContain('Required upstream signature was not preserved')
    expect(windowsRun).toContain("Join-Path $signingStage 'bin/node.exe'")
    expect(windowsRun).toContain('ssh-relay-runtime-windows-source-signature-verification.mjs')
    expect(
      windowsRun.indexOf('ssh-relay-runtime-windows-source-signature-verification.mjs')
    ).toBeGreaterThan(windowsRun.indexOf('ssh-relay-runtime-native-signing-stage.mjs'))
    expect(
      windowsRun.indexOf('ssh-relay-runtime-windows-source-signature-verification.mjs')
    ).toBeLessThan(windowsRun.indexOf('Remove-Item -LiteralPath $signingStage'))
    expect(windowsRun).toContain(
      'Windows source signature report violates the immutable/preserved trust contract'
    )
    expect(windowsRun).toContain("$_.signerKind -eq 'official-node'")
    expect(windowsRun).toContain("$_.signerKind -eq 'preserved-upstream'")
    expect(source.match(/\.signing-stage\.json/g)).toHaveLength(3)
    expect(source.match(/\.source-signatures\.json/g)).toHaveLength(1)
    expect(source).not.toMatch(/SIGNPATH_|APPLE_(?:ID|KEY)|Developer ID Application/)
  })

  it('builds Linux native modules in the pinned oldest userland with an offline build phase', async () => {
    const source = await readFile(workflowUrl, 'utf8')
    const workflow = parse(source)
    const job = workflow.jobs['build-posix-runtime']
    const prepare = job.steps.find(
      (step) => step.name === 'Prepare digest-pinned Linux floor builder'
    )
    const build = job.steps.find(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    )
    const containerfile = await readFile(linuxBuilderUrl, 'utf8')
    // Why: Git may materialize CRLF on Windows, but the Containerfile contract is newline-agnostic.
    const normalizedContainerfile = normalizeCheckoutNewlines(containerfile)

    expect(prepare.if).toBe("runner.os == 'Linux'")
    expect(prepare.run).toContain('docker pull "$image"')
    expect(prepare.run).toContain('--pull=false')
    expect(prepare.run).toContain('config/ssh-relay-runtime-linux-builder.Containerfile')
    expect(build.run).toContain("if [[ '${{ matrix.tuple }}' == linux-* ]]")
    expect(build.run).toContain('--network none --read-only --cap-drop all')
    expect(build.run).toContain('--user "$(id -u):$(id -g)"')
    expect(build.run).toContain('--security-opt no-new-privileges')
    expect(build.run).toContain('--tmpfs /tmp:rw,nosuid,size=1g,mode=1777')
    expect(build.run).toContain('ssh-relay-runtime-linux-build-evidence.mjs')
    expect(build.run.indexOf('--network none')).toBeLessThan(
      build.run.indexOf('ssh-relay-runtime-linux-build-evidence.mjs')
    )
    expect(normalizedContainerfile).toContain('ARG BASE_IMAGE=scratch\nFROM ${BASE_IMAGE}')
    expect(normalizedContainerfile).toContain("getconf GNU_LIBC_VERSION)\" = 'glibc 2.28'")
    expect(normalizedContainerfile).toContain('libstdc++.so.6.0.25')
    expect(normalizedContainerfile).toContain('dnf module enable -y -q nodejs:20')
    expect(normalizedContainerfile).toContain('Number(process.versions.node.split')
    expect(normalizedContainerfile).toContain('python39')
    expect(normalizedContainerfile).toContain('NODE_GYP_FORCE_PYTHON=/usr/bin/python3.9')
    expect(normalizedContainerfile).toContain('      which \\\n')
    expect(source).not.toMatch(
      /github\.com\/stablyai\/orca\/releases\/|gh release|contents:\s*write/i
    )
  })

  it('separates qualifying Windows floors from supplemental Linux userland evidence', async () => {
    const source = await readFile(workflowUrl, 'utf8')
    const workflow = parse(source)
    const linuxJob = workflow.jobs['verify-linux-runtime-baseline-userland']
    const windowsJob = workflow.jobs['verify-windows-runtime-baseline']

    expect(linuxJob.needs).toBe('build-posix-runtime')
    expect(windowsJob.needs).toBe('build-windows-runtime')
    expect(linuxJob.strategy.matrix.include).toEqual([
      {
        runner: 'ubuntu-24.04',
        tuple: 'linux-x64-glibc',
        container_image:
          'docker.io/library/rockylinux@sha256:2d05a9266523bbf24f33ebc3a9832e4d5fd74b973c220f2204ca802286aa275d'
      },
      {
        runner: 'ubuntu-24.04-arm',
        tuple: 'linux-arm64-glibc',
        container_image:
          'docker.io/library/rockylinux@sha256:3c2d0ce12bf79fc5ff05e43b1000e30ff062dc89405525f3307cbff71661f1a0'
      }
    ])
    expect(windowsJob.strategy.matrix.include).toEqual([
      { runner: 'windows-2022', tuple: 'win32-x64' },
      { runner: 'windows-11-arm', tuple: 'win32-arm64' }
    ])
    for (const job of [linuxJob, windowsJob]) {
      expect(job.env.ORCA_RUNTIME_REQUESTED_RUNNER).toBe('${{ matrix.runner }}')
      expect(job['timeout-minutes']).toBe(15)
      expect(job.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}')
      for (const step of job.steps.filter((candidate) => candidate.uses)) {
        expect(step.uses).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/)
      }
    }

    const linuxRun = linuxJob.steps.find(
      (step) => step.name === 'Prove oldest Linux userland and retain the kernel gap'
    ).run
    expect(linuxRun).toContain('--scope linux-userland')
    expect(linuxRun).toContain('--network none')
    expect(linuxRun).toContain('--read-only --cap-drop all')
    expect(linuxRun).toContain('--security-opt no-new-privileges')
    expect(linuxRun).toContain('ssh-relay-runtime-smoke-child.cjs')
    expect(linuxRun).not.toContain('--scope full')

    const linuxVerification = linuxJob.steps.find(
      (step) => step.name === 'Verify bytes before supplemental baseline execution'
    ).run
    expect(linuxVerification).toContain('${#identities[@]} != 1')
    expect(linuxVerification).toContain('${#archives[@]} != 1')

    const windowsRun = windowsJob.steps.find(
      (step) => step.name === 'Verify bytes and execute on the declared Windows floor'
    ).run
    expect(windowsRun.indexOf('verify-ssh-relay-runtime.mjs')).toBeLessThan(
      windowsRun.indexOf('ssh-relay-runtime-baseline.mjs')
    )
    expect(windowsRun).toContain('--scope full')
    expect(windowsRun).toContain('$identities.Count -ne 1')
    expect(windowsRun).toContain('$archives.Count -ne 1')
    expect(source).not.toMatch(
      /github\.com\/stablyai\/orca\/releases\/|gh release|contents:\s*write/i
    )
  })
})
