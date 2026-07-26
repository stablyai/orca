export const REMOTE_NODE_PROFILE_MAX_BYTES = 64 * 1024
export const REMOTE_NODE_NVM_DIR_MAX_BYTES = 4 * 1024
export const REMOTE_NODE_CANDIDATE_MAX_COUNT = 256
export const REMOTE_NODE_CANDIDATE_MAX_UTF8_BYTES = 64 * 1024
export const REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL = '__ORCA_NODE_CANDIDATES_TOO_LARGE__'

type RemoteNodeCandidateProbeOptions = {
  maxCandidates?: number
  maxUtf8Bytes?: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return resolved
}

export function isRemoteNodeCandidateProbeLimited(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL)
}

export function buildPosixRemoteNodeCandidateProbe(
  options?: RemoteNodeCandidateProbeOptions
): string {
  const maxCandidates = positiveInteger(
    options?.maxCandidates,
    REMOTE_NODE_CANDIDATE_MAX_COUNT,
    'maxCandidates'
  )
  const maxUtf8Bytes = positiveInteger(
    options?.maxUtf8Bytes,
    REMOTE_NODE_CANDIDATE_MAX_UTF8_BYTES,
    'maxUtf8Bytes'
  )

  return `
nvm_dirs=\${NVM_DIR:-"$HOME/.nvm"}
nvm_dirs_bytes=$(LC_ALL=C printf %s "$nvm_dirs" | wc -c | tr -d '[:space:]')
[ "\${nvm_dirs_bytes:-${REMOTE_NODE_NVM_DIR_MAX_BYTES + 1}}" -le ${REMOTE_NODE_NVM_DIR_MAX_BYTES} ] 2>/dev/null || nvm_dirs="$HOME/.nvm"
for nvm_file in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"
do
  [ -r "$nvm_file" ] || continue
  profile_bytes=$(dd if="$nvm_file" bs=1024 count=65 2>/dev/null | wc -c | tr -d '[:space:]')
  [ "\${profile_bytes:-${REMOTE_NODE_PROFILE_MAX_BYTES + 1}}" -le ${REMOTE_NODE_PROFILE_MAX_BYTES} ] 2>/dev/null || continue
  nvm_dir_from_file=$(dd if="$nvm_file" bs=1024 count=64 2>/dev/null | sed -n 's/^[[:space:]]*export[[:space:]][[:space:]]*NVM_DIR[[:space:]]*=[[:space:]]*//p; s/^[[:space:]]*NVM_DIR[[:space:]]*=[[:space:]]*//p' | tail -n 1)
  case "$nvm_dir_from_file" in
    \\"*\\") nvm_dir_from_file=\${nvm_dir_from_file#\\"}; nvm_dir_from_file=\${nvm_dir_from_file%%\\"*} ;;
    \\'*\\') nvm_dir_from_file=\${nvm_dir_from_file#\\'}; nvm_dir_from_file=\${nvm_dir_from_file%%\\'*} ;;
    *) nvm_dir_from_file=\${nvm_dir_from_file%%[[:space:]]*} ;;
  esac
  case "$nvm_dir_from_file" in
    '$HOME'*) nvm_dir_from_file="$HOME\${nvm_dir_from_file#'$HOME'}" ;;
    "~/"*) nvm_dir_from_file="$HOME/\${nvm_dir_from_file#\\~/}" ;;
  esac
  nvm_dir_bytes=$(LC_ALL=C printf %s "$nvm_dir_from_file" | wc -c | tr -d '[:space:]')
  [ "\${nvm_dir_bytes:-${REMOTE_NODE_NVM_DIR_MAX_BYTES + 1}}" -le ${REMOTE_NODE_NVM_DIR_MAX_BYTES} ] 2>/dev/null || continue
  [ -n "$nvm_dir_from_file" ] && nvm_dirs="$nvm_dirs
$nvm_dir_from_file"
done

find_node_candidates() {
  candidate_root=$1
  candidate_suffix=$2
  [ -d "$candidate_root" ] || return 0
  find "$candidate_root" -mindepth 1 -maxdepth 1 ! -name '.*' -exec sh -c '
    candidate_suffix=$1
    shift
    for candidate_dir
    do
      candidate=$candidate_dir/$candidate_suffix
      [ -x "$candidate" ] && printf "%s\\n" "$candidate"
    done
  ' sh "$candidate_suffix" {} + | LC_ALL=C awk '
    {
      line_bytes=length($0)+1
      if(candidate_count>=${maxCandidates} || output_bytes+line_bytes>${maxUtf8Bytes}) {
        print "${REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL}"
        exit
      }
      print
      candidate_count++
      output_bytes+=line_bytes
    }
  ' | sort
}

{
  command -v node 2>/dev/null
  printf '%s\\n' "$nvm_dirs" | while IFS= read -r nvm_dir
  do
    [ -n "$nvm_dir" ] || continue
    find_node_candidates "$nvm_dir/versions/node" "bin/node"
  done
  for candidate in \\
    /usr/local/bin/node \\
    /opt/homebrew/bin/node \\
    "$HOME/.local/bin/node" \\
    "$HOME/.fnm/aliases/default/bin/node"
  do
    [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  done
  find_node_candidates "$HOME/.fnm/node-versions" "installation/bin/node"
  find_node_candidates "$HOME/.local/share/fnm/node-versions" "installation/bin/node"
  candidate="$HOME/.local/share/mise/shims/node"; [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  find_node_candidates "$HOME/.local/share/mise/installs/node" "bin/node"
  candidate="$HOME/.asdf/shims/node"; [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  find_node_candidates "$HOME/.asdf/installs/nodejs" "bin/node"
  candidate="$HOME/.volta/bin/node"; [ -x "$candidate" ] && printf '%s\\n' "$candidate"
  find_node_candidates "/usr/local/n/versions/node" "bin/node"
} | LC_ALL=C awk '
  {
    candidate=$0
    if(candidate=="${REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL}") {
      print candidate
      exit
    }
    if(candidate=="" || seen[candidate]) next
    line_bytes=length(candidate)+1
    if(candidate_count>=${maxCandidates} || output_bytes+line_bytes>${maxUtf8Bytes}) {
      print "${REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL}"
      exit
    }
    seen[candidate]=1
    print candidate
    candidate_count++
    output_bytes+=line_bytes
  }
'
true
`
}
