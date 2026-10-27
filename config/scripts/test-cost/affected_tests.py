#!/usr/bin/env python3
"""Select bounded JS/Python tests; never silently fall back to a full suite.

TEST_BASE chooses a Git baseline; TEST_COST_TARGETS is a JSON array of existing
exact test files. TEST_GATE_FULL=<reason> opts into a full merge-batch run.
--shell-launcher-json '["firebase","emulators:exec",...]' wraps the selected
runner as one shell-command argument, so the gate owns service startup too.
Playwright's changed graph covers test imports, not black-box app dependencies;
use explicit TEST_COST_TARGETS for app-to-E2E mappings.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

RUNNERS = ('vitest', 'jest', 'playwright', 'pytest')
CHANGE_FLAGS = ('--changed', '--changedSince', '--only-changed')
RETRY_FLAGS = ('--last-failed', '--lastFailed', '--onlyFailures')
VALUE_FLAGS = {
    '--config', '-c', '--root', '--dir', '--environment', '--reporter', '--project',
    '--output', '--outputFile', '--testNamePattern', '-t', '--grep', '-g',
    '--grep-invert', '-G', '--testPathPattern', '--testPathPatterns', '--timeout',
    '--global-timeout', '--max-failures', '--repeat-each', '--shard', '--pool',
    '--maxWorkers', '--minWorkers', '--workers', '-j', '--testTimeout', '--retry',
    '-k', '-m', '-p', '-o', '-n', '--tb', '--junitxml', '--rootdir', '--maxfail',
}


def git(*args):
    result = subprocess.run(['git', *args], text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError('git ' + ' '.join(args) + ': ' + result.stderr.strip())
    return result.stdout.strip()


def baseline():
    explicit = os.environ.get('TEST_BASE')
    if explicit:
        return git('rev-parse', '--verify', explicit + '^{commit}')
    event_file = os.environ.get('GITHUB_EVENT_PATH')
    if event_file:
        event = json.loads(Path(event_file).read_text())
        ref = event.get('pull_request', {}).get('base', {}).get('sha') or event.get('before')
        if ref and set(ref) != {'0'}:
            git('rev-parse', '--verify', ref + '^{commit}')
            return git('merge-base', 'HEAD', ref)
        raise ValueError('CI baseline missing; set TEST_BASE to the merge-batch base')
    for ref in ('origin/main', 'origin/master'):
        try:
            return git('merge-base', 'HEAD', ref)
        except ValueError:
            pass
    raise ValueError('no baseline; set TEST_BASE or pass exact test paths (no automatic full fallback)')


def remove_options(args, names, with_value=False, optional_value=False):
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        name = arg.split('=', 1)[0]
        if name in names:
            if '=' not in arg and index + 1 < len(args):
                following = args[index + 1]
                if with_value or (optional_value and not following.startswith('-')):
                    index += 1
        else:
            result.append(arg)
        index += 1
    return result


def file_part(value):
    return value.split('::', 1)[0]  # pytest node IDs preserve the test case suffix


def exact_file_indices(args):
    indices = []
    index = 1
    while index < len(args):
        arg = args[index]
        if arg in VALUE_FLAGS or arg in CHANGE_FLAGS:
            index += 2
            continue
        if not arg.startswith('-'):
            path = Path(file_part(arg))
            test_name = '.test.' in path.name or '.spec.' in path.name or path.name.startswith('test_') or path.name.endswith('_test.py') or '__tests__' in path.parts
            if test_name and path.is_file():
                indices.append(index)
        index += 1
    return indices


def remove_broad_path_filters(args):
    result = [args[0]]
    index = 1
    while index < len(args):
        arg = args[index]
        if arg in VALUE_FLAGS:
            result.extend(args[index:index + 2])
            index += 2
            continue
        if arg.startswith('-') or arg in ('run', 'test', 'related', 'list') or not Path(arg).is_dir():
            result.append(arg)
        index += 1
    return result


def selector_present(args):
    for arg in args:
        name = arg.split('=', 1)[0]
        if name in CHANGE_FLAGS + RETRY_FLAGS:
            if '=' in arg and arg.split('=', 1)[1].lower() in ('', 'false', '0'):
                raise ValueError(f'{name} cannot disable the affected selector')
            return True
    # Jest's related mode is bounded only with actual source-file operands.
    if '--findRelatedTests' in args:
        index = args.index('--findRelatedTests')
        return any(not arg.startswith('-') and Path(arg).is_file() for arg in args[index + 1:])
    return False


def worker_limit(args, names):
    limit = 2
    for index, arg in enumerate(args):
        name, _, inline = arg.partition('=')
        if name not in names:
            continue
        value = inline if '=' in arg else (args[index + 1] if index + 1 < len(args) else '')
        if value.isdigit() and int(value) > 0:
            limit = min(limit, int(value))
    return limit


def bounded_options(args, runner):
    if any(arg.split('=', 1)[0] in ('--ui', '--debug', '--inspect', '--inspect-brk') for arg in args):
        raise ValueError('interactive UI/debug mode is not a bounded test run; select test files for this entrypoint')
    args = remove_options(args, ('--watch', '--watchAll'))
    if runner == 'vitest':
        args = [arg for arg in args if arg not in ('watch', 'dev', '-w')]
        if len(args) < 2 or args[1] not in ('run', 'list', 'related', 'bench'):
            args.insert(1, 'run')
        if 'bench' in args:
            raise ValueError('benchmarks use the repository manual performance entrypoint')
        workers = worker_limit(args, ('--maxWorkers',))
        args = remove_options(args, ('--maxWorkers', '--minWorkers'), with_value=True)
        args = remove_options(args, ('--fileParallelism', '--file-parallelism'))
        # Supported by Vitest 2–4; also avoids v2 minThreads > maxThreads on big Macs.
        args.extend([f'--maxWorkers={workers}', '--no-file-parallelism'])
    elif runner == 'jest':
        workers = worker_limit(args, ('--maxWorkers', '-w'))
        args = remove_options(args, ('--maxWorkers', '-w'), with_value=True)
        if '--runInBand' not in args and '-i' not in args:
            args.append(f'--maxWorkers={workers}')
        args.append('--watch=false')
    elif runner == 'playwright':
        if len(args) < 2 or args[1] != 'test':
            raise ValueError('playwright entrypoint requires the test subcommand')
        workers = worker_limit(args, ('--workers', '-j'))
        args = remove_options(args, ('--workers', '-j'), with_value=True)
        args.append(f'--workers={workers}')
    return args


def main(argv):
    launcher = []
    if argv[:1] == ['--shell-launcher-json']:
        if len(argv) < 2:
            raise ValueError('--shell-launcher-json requires a JSON array')
        launcher = json.loads(argv[1])
        if not isinstance(launcher, list) or not launcher or any(not isinstance(arg, str) or not arg for arg in launcher):
            raise ValueError('--shell-launcher-json must be a nonempty string array')
        argv = argv[2:]
    if argv[:1] == ['--']:
        argv = argv[1:]
    if not argv:
        raise ValueError('usage: affected_tests.py [--shell-launcher-json ARRAY] -- vitest|jest|playwright|pytest ...')
    args = list(argv)
    runner = Path(args[0]).name
    if runner not in RUNNERS:
        raise ValueError('unsupported automatic selector: pass the repository affected runner through test_gate.sh')
    full = bool(os.environ.get('TEST_GATE_FULL', '').strip())
    targets = json.loads(os.environ.get('TEST_COST_TARGETS', '[]'))
    if not isinstance(targets, list) or any(not isinstance(path, str) or not path or path.startswith('-') or not Path(file_part(path)).is_file() for path in targets):
        raise ValueError('TEST_COST_TARGETS must be a JSON array of existing exact test files')
    exact = bool(targets or exact_file_indices(args))
    automatic = False
    if not full:
        if exact:
            # An exact-file retry must not be intersected with stale changed/failed state.
            args = remove_options(args, CHANGE_FLAGS, optional_value=True)
            args = remove_options(args, RETRY_FLAGS)
            args = remove_options(args, ('--findRelatedTests',))
            args = remove_broad_path_filters(args)
            args.extend(targets)
            if runner == 'jest' and '--runTestsByPath' not in args:
                args.append('--runTestsByPath')
        elif not selector_present(args):
            if runner == 'pytest':
                raise ValueError('pytest needs exact affected files or TEST_COST_TARGETS; use the repository dependency selector')
            base = baseline()
            flag = {'vitest': '--changed=', 'jest': '--changedSince=', 'playwright': '--only-changed='}[runner]
            args.append(flag + base)
            automatic = True
        else:
            automatic = True
        if any(arg.startswith('--coverage') and arg not in ('--coverage=false', '--coverage.enabled=false') for arg in args):
            raise ValueError('aggregate coverage needs TEST_GATE_FULL=<merge-batch reason>')
    args = bounded_options(args, runner)
    if automatic:
        flag = {'vitest': '--passWithNoTests', 'jest': '--passWithNoTests', 'playwright': '--pass-with-no-tests'}.get(runner)
        if flag and flag not in args:
            args.append(flag)
    env = dict(os.environ, TEST_GATE_SCOPE='full' if full else 'affected')
    gate = Path(__file__).resolve().with_name('test_gate.sh')
    execution = launcher + [shlex.join(args)] if launcher else args
    command = ['sh', str(gate), *execution]
    if os.environ.get('TEST_COST_DRY_RUN') == '1':
        print(json.dumps({'scope': env['TEST_GATE_SCOPE'], 'command': command}))
        return 0
    if not gate.is_file():
        raise ValueError('missing vendored test_gate.sh; restore scripts/test-cost runtime')
    print('test-cost: ' + shlex.join(execution), file=sys.stderr)
    os.execvpe('sh', command, env)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('test-cost: ' + str(error), file=sys.stderr)
        sys.exit(2)
