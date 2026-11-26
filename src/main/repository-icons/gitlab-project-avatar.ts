import { detectImageFileSignature } from '../../shared/file-content/image-file-signature'
import {
  MAX_REPO_ICON_DATA_URL_LENGTH,
  MAX_REPO_ICON_UPLOAD_BYTES,
  type RepoIcon
} from '../../shared/repository/appearance/repo-icon'
import { glabExecFileAsync } from '../git/command-runner/hosted-cli/glab-exec-file'
import {
  getProjectRef,
  glabRepoExecOptions
} from '../gitlab/projects/gitlab-project-ref-resolution'
import type { LocalGitExecOptions } from '../gitlab/projects/gitlab-known-host-probe'
import { encodedProject } from '../gitlab/projects/project-path-encoding'
import { acquire, release } from '../gitlab/requests/glab-request-admission'
import { getRuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import {
  iconDataUrl,
  type IconPngEncoder
} from '../runtime/sidebar-inputs/repo-icons/icon-data-url'

export function gitLabAvatarFromBytes(
  bytes: Uint8Array,
  projectPath: string,
  encoder?: IconPngEncoder
): RepoIcon | null {
  if (bytes.byteLength > MAX_REPO_ICON_UPLOAD_BYTES) {
    return null
  }
  const signature = detectImageFileSignature(bytes)
  if (!signature) {
    return null
  }
  const src = iconDataUrl(
    { bytes, mimeType: signature.mimeType },
    {
      maxDataUrlLength: MAX_REPO_ICON_DATA_URL_LENGTH,
      maxDecodeEdgePx: 512,
      encodedEdgesPx: [64, 32]
    },
    encoder
  )
  return src ? { type: 'image', source: 'gitlab', src, label: projectPath } : null
}

/** Runs on the repository's runtime, keeping credentials and private image requests on its host. */
export async function detectGitLabProjectAvatar(
  repoPath: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<RepoIcon | null> {
  const project = await getProjectRef(repoPath, undefined, null, localGitOptions)
  if (!project) {
    return null
  }
  let acquired = false
  try {
    await acquire()
    acquired = true
    const { stdout } = await glabExecFileAsync(
      ['api', '--hostname', project.host, `projects/${encodedProject(project.path)}/avatar`],
      {
        ...glabRepoExecOptions(repoPath, null, localGitOptions),
        encoding: 'buffer',
        maxBuffer: MAX_REPO_ICON_UPLOAD_BYTES,
        timeout: 5_000,
        idempotent: false
      }
    )
    return gitLabAvatarFromBytes(stdout, project.path, getRuntimeDesktopSurface().encodeRepoIconPng)
  } catch {
    // Optional metadata: retain the cached avatar or initials when offline or unauthorized.
    return null
  } finally {
    if (acquired) {
      release()
    }
  }
}
