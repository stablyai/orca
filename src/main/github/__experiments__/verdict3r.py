"""STA-8667 D3r: computes every pass rule of design section 15 from results/*.json.

Usage: python3 verdict3r.py [results-dir] [--rerun <dir>] [--digests <file>]
  results-dir   default: results/ next to this script
  --rerun DIR   a second run of some of the same scenarios; their digests must be identical (rule G)
  --digests F   "<name> <spawnDigest>" lines (local-digests.txt); the same names here must match (rule G)

Prints one line per rule per scenario: PASS / FAIL / REPORT, then a summary. Exit code 1 if any FAIL.
"""
import glob
import json
import math
import os
import sys

args = sys.argv[1:]
HERE = os.path.dirname(os.path.abspath(__file__))
rerun_dir = None
digest_file = None
positional = []
i = 0
while i < len(args):
    if args[i] == '--rerun':
        rerun_dir = args[i + 1]; i += 2
    elif args[i] == '--digests':
        digest_file = args[i + 1]; i += 2
    else:
        positional.append(args[i]); i += 1
S = positional[0] if positional else os.path.join(HERE, 'results')

results = {}
for f in sorted(glob.glob(S + '/*.json')):
    n = os.path.basename(f)[:-5]
    if n.endswith('.probe'):
        continue
    results[n] = json.load(open(f))

fails = 0
passes = 0


def line(verdict, name, rule, detail):
    global fails, passes
    if verdict == 'FAIL':
        fails += 1
    if verdict == 'PASS':
        passes += 1
    print(f'{verdict:6s} {name:44s} {rule:34s} {detail}')


def check(name, rule, ok, detail):
    line('PASS' if ok else 'FAIL', name, rule, detail)


def strip_local(n):
    return n[6:] if n.startswith('local-') else n


# ---------------------------------------------------------------- D lanes
for n, r in results.items():
    b = strip_local(n)
    s = r.get('serve')
    if not b.startswith('lanes-') or not s or not s.get('lanes'):
        continue
    L = s['lanes']
    rows = r['config']['n']
    vis = L['lanes']['visible']
    if s['gate'] != 'd3':
        line('REPORT', n, 'D before (D2 gate)', f"neverServed={L['visibleIdentities']['neverServed']} of {L['visibleIdentities']['seen']} visibleStarts={vis['starts']}")
        continue
    limit = 300 * math.ceil((rows + 5) / 15)
    check(n, 'D neverServed = 0', L['visibleIdentities']['neverServed'] == 0, f"{L['visibleIdentities']['neverServed']}")
    check(n, 'D visible pk5min <= 15', vis['peak5min'] <= 15, f"{vis['peak5min']}")
    check(n, 'D selected pk5min <= 10', L['selectedTotal']['peak5min'] <= 10, f"{L['selectedTotal']['peak5min']}")
    check(n, 'D budgeted pk5min <= 20', L['budgeted']['peak5min'] <= 20, f"{L['budgeted']['peak5min']}")
    check(n, 'D budgeted pk60 <= 11', L['budgeted']['peak60s'] <= 11, f"{L['budgeted']['peak60s']}")
    w = vis['waitedSinceFirstRefusalS']['max'] or 0
    check(n, f'D visible wait max <= {limit}', w <= limit, f"{w} s (R={rows})")
    line('REPORT', n, 'D selected identities maxGapS', ' '.join(f"{x['identity']}={x['maxGapS']}" for x in s['selectedIdentities']))

# ---------------------------------------------------------------- E timeouts, cancellation
REF = {
    'cancel-disconnect20-n50-c3': ['cancel-ref-n50-c3', 'serve-after-n50-c3-disjoint'],
    'cancel-disconnect15-n20-c3': ['cancel-ref-n20-c3'],
}
for n, r in results.items():
    b = strip_local(n)
    s = r.get('serve')
    if not s or not (b.startswith('timeout-') or b.startswith('cancel-')):
        continue
    if b.startswith('cancel-ref-'):
        continue
    check(n, 'E rpc over 10 s = 0', s['rpcSimulatedMs']['over10s'] == 0, f"{s['rpcSimulatedMs']['over10s']} (max {s['maxRpcSimulatedMs']} ms)")
    check(n, 'E clientFailures = 0', s['clientFailures'] == 0, f"{s['clientFailures']} of {s['clientRefreshCalls']}")
    if b.startswith('timeout-'):
        check(n, 'E replyDeadlineHits > 0', s['replyDeadlineHits'] > 0, f"{s['replyDeadlineHits']}")
    if r['config'].get('allGoneMin') is not None:
        check(n, 'E starts after all gone = 0', s['upstreamStartsAfterAllClientsGone'] == 0, f"{s['upstreamStartsAfterAllClientsGone']}")
    if r['config'].get('focus') == 'hidden':
        later = sum(r['gh']['timelinePerMinute'][1:])
        check(n, 'E hidden: spawns after minute 0 = 0', later == 0, f"{later}")
    if r['config'].get('disconnectMin') is not None:
        ref_name = next((prefix + x for x in REF.get(b, []) for prefix in (n[: len(n) - len(b)], '') if prefix + x in results), None)
        if ref_name is None or not s.get('queueAgeSeries'):
            line('FAIL', n, 'E queue age after disconnect', 'no reference run or no queueAgeSeries in the JSON')
            fails += 0
            continue
        a = s['queueAgeSeries']
        ref = results[ref_name]['serve']['queueAgeSeries']
        W = a['windowSeconds']
        t = r['config']['disconnectMin'] * 60
        # First window that starts at least one whole window after the disconnect.
        w0 = math.ceil((t + W) / W)
        last = min(a['windows'], ref['windows'])
        # Host view per window: the oldest queue age among the starts of the clients that are still
        # there, against the oldest among ALL clients of the same window in the run without the
        # disconnect. (Per client it is not comparable: rows the vanished client used to fetch
        # first are now fetched by whoever is left, so that client inherits its waits.)
        def level(series, skip):
            out = []
            for w in range(w0, last):
                out.append(max([(v['ageMaxS'][w] or 0) for c, v in series['byClient'].items() if c not in skip] + [0]))
            return out
        mine = level(a, {'1'})
        base = level(ref, set())
        # 15 s = the claim grace an absent claimant can cost (design 4.4).
        bad = [w0 + k for k in range(len(mine)) if mine[k] > base[k] + 15]
        print(f"       host queue age per {W} s window, windows {w0}..{last - 1}: disconnect={mine} reference={base}")
        check(n, f'E queue age at reference level from window {w0}', not bad, f"worst {max(mine + [0])} s vs reference {max(base + [0])} s; windows over reference+15 s: {bad or 'none'} [ref {ref_name}]")

# ---------------------------------------------------------------- C serve cost
for n, r in results.items():
    b = strip_local(n)
    s = r.get('serve')
    if not s or not b.startswith('serve-'):
        continue
    check(n, 'C clientFailures = 0', s['clientFailures'] == 0, f"{s['clientFailures']} of {s['clientRefreshCalls']}")
    if 'oldclient' in b:
        check(n, 'C legacy: gate untouched', not s['admits'], f"admits={s['admits']} legacy={s['legacy']}")
    line('REPORT', n, 'C spawns per hour', f"{r['gh']['perHourCounts']}")

# ---------------------------------------------------------------- A, B desktop
for n, r in results.items():
    b = strip_local(n)
    if not (b.startswith('ghes-desk-') or b.startswith('dotcom-desk-') or b.startswith('capcost-')):
        continue
    if r['config'].get('focus') == 'hidden':
        check(n, 'A hidden = 0 spawns', r['gh']['spawns'] == 0, f"{r['gh']['spawns']}")
    k = r['gh']['lastHourByKind']
    line('REPORT', n, 'A/B/H spawns per hour', f"{r['gh']['perHourCounts']} lastHour auth={k.get('auth:status', 0)} reqLowerBound={sum(k.values()) + 2 * k.get('auth:status', 0)}")

# ---------------------------------------------------------------- F detection
for n, r in results.items():
    d = r.get('detection')
    if not d or 'classes' not in d:
        continue
    after = r['config']['scenario'] in ('desktop-after', 'serve-after')
    c = d['classes']

    def cell(key):
        x = c[key]
        return f"n={x['latencyS']['samples']} max={x['latencyS']['max']} slotMax={x['slotWaitS']['max']} netMax={x['latencyMinusSlotWaitS']['max']} bound={x['boundS']} over={x['overBound']}"

    if after:
        over_fin = c['finishSeenRunningSelected']['overBound'] + c['finishSeenRunningVisible']['overBound']
        over_stuck = c['finishSeenStuckVisible']['overBound']
        over_cap = d['overBound'] - over_fin - over_stuck
        if c['finishSeenStuckVisible']['latencyS']['samples']:
            check(n, 'F1b finish on the stuck ladder', over_stuck == 0, f"vis[{cell('finishSeenStuckVisible')}]")
        check(n, 'F1 finish of a seen run in 70/130+slot', over_fin == 0, f"sel[{cell('finishSeenRunningSelected')}] vis[{cell('finishSeenRunningVisible')}]")
        check(n, 'F2 every other event in cap+10+slot', over_cap == 0, f"startSeen sel[{cell('startSeenSelected')}] vis[{cell('startSeenVisible')}] transient sel[{cell('startTransientSelected')}] vis[{cell('startTransientVisible')}] finishUnseen sel[{cell('finishRunNeverSeenSelected')}] vis[{cell('finishRunNeverSeenVisible')}]")
        check(n, 'F3 uncovered = 0', d['uncovered'] == 0, f"{d['uncovered']} (pending at end of run: {d['pendingAtEnd']})")
    else:
        line('REPORT', n, 'F before / legacy', f"finishSeen sel[{cell('finishSeenRunningSelected')}] vis[{cell('finishSeenRunningVisible')}] uncovered={d['uncovered']}")
    runs = sum(1 for e in d['perEvent'] if e['kind'] == 'start')
    line('REPORT', n, 'F runs never shown as running', f"{d['transientRunPairs']} of {runs * d['observers']} (run, observer) pairs; D3 'undetected' counter={d['undetected']}; worst slot wait {d['worstSlotWaitS']} s")

# ---------------------------------------------------------------- G determinism
if rerun_dir:
    for f in sorted(glob.glob(rerun_dir + '/*.json')):
        n = os.path.basename(f)[:-5]
        if n not in results:
            continue
        first = results[n]
        second = json.load(open(f))
        a = first.get('determinism', {})
        b2 = second.get('determinism', {})
        # Host-level identity: every gh spawn at the same simulated millisecond, the same lane
        # summary and the same detection report.
        same = (
            a.get('spawnDigest') is not None
            and a.get('spawnDigest') == b2.get('spawnDigest')
            and (first.get('serve') or {}).get('lanes') == (second.get('serve') or {}).get('lanes')
            and first.get('detection') == second.get('detection')
            and first['gh'] == second['gh']
        )
        check(n, 'G rerun identical (host level)', same, f"spawnDigest {str(a.get('spawnDigest'))[:16]} vs {str(b2.get('spawnDigest'))[:16]}")
        # Which client a start is attributed to can differ when two clients ask for the same row in
        # the same simulated millisecond (their order follows the completion order of real fs
        # calls). Reported, not judged: no rule uses per-client attribution.
        if a.get('gateDigest') != b2.get('gateDigest'):
            x = (first.get('serve') or {}).get('queueAgeSecondsByClient')
            y = (second.get('serve') or {}).get('queueAgeSecondsByClient')
            line('REPORT', n, 'G per-client attribution differs', f"{x} vs {y}")
if digest_file:
    for row in open(digest_file):
        parts = row.split()
        if len(parts) < 2 or parts[0].startswith('#'):
            continue
        if parts[0] not in results:
            line('REPORT', parts[0], 'G digest of the authoring Mac', 'scenario not in this results directory')
            continue
        got = results[parts[0]].get('determinism', {}).get('spawnDigest')
        check(parts[0], 'G digest equals authoring Mac', got == parts[1], f"{str(got)[:16]} vs {parts[1][:16]}")

for n, r in results.items():
    if r['unknownGit'] or r['unknownGh']:
        line('FAIL', n, 'unknown gh/git command', f"{r['unknownGit']} {r['unknownGh']}")

print(f'\nSUMMARY scenarios={len(results)} PASS={passes} FAIL={fails}')
sys.exit(1 if fails else 0)
