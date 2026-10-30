#!/usr/bin/env python3
"""Inspect focused native text interfaces on a disposable desktop."""
import argparse
import os
from pathlib import Path
import sys
import time


def main():
    if (sys.platform != 'linux' or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('ORCA_COMPUTER_BENCH_ISOLATED') != '1'
            or os.environ.get('ORCA_BACKGROUND_LAUNCH') != '1'):
        raise SystemExit('focused text probe requires isolated Linux CI')
    sys.stdout.reconfigure(encoding='utf-8')
    import bench
    import obs_x11 as obs
    from linux_focus_probe import load_runtime
    from trial_contract import SELECTORS, select_unique, DiscoveryError
    bench.obs = obs
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--electron', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / 'sources'
    evidence = {'source': bench.pin_source(args.source, sources / 'candidate')}
    runtime = load_runtime(sources / 'candidate/native/computer-use-linux/runtime.py', 'focused_probe')
    with (args.out / 'engines.log').open('ab') as log:
        trial = bench.Trial(args, args.out / 'trial', log)
        try:
            trial.launch()
            trial.prepare('replace_submit')
            engine = trial.engine('candidate', sources)
            def ready():
                elements = engine.snapshot()
                try:
                    return select_unique(elements, SELECTORS['field'])
                except DiscoveryError:
                    return None
            field = bench.wait_for(ready, 15)
            evidence['click'] = engine.act('click', field, True)
            app = runtime.find_app(f'pid:{trial.pid}')
            _, window = runtime.choose_window(app, window_index=0)
            node = runtime.first_descendant(window, lambda n: runtime.has_state(n, runtime.Atspi.StateType.FOCUSED))
            text = runtime.text_iface(node)
            editable = runtime.attempt(node.get_editable_text_iface)
            record = {'name': runtime.name_of(node), 'role': runtime.role_of(node),
                      'states': {name: runtime.has_state(node, getattr(runtime.Atspi.StateType, name))
                                 for name in ('FOCUSED', 'EDITABLE', 'FOCUSABLE', 'ENABLED', 'SHOWING')},
                      'interfaces': runtime.attempt(lambda: node.get_interfaces()),
                      'has_text': text is not None, 'has_editable': editable is not None}
            evidence['focused'] = record
            if text is not None:
                for key, fn in {'caret': lambda: runtime.Atspi.Text.get_caret_offset(text),
                                'selection_count': lambda: runtime.Atspi.Text.get_n_selections(text),
                                'character_count': lambda: runtime.Atspi.Text.get_character_count(text),
                                'selection': lambda: runtime.Atspi.Text.get_selection(text, 0),
                                'contents': lambda: runtime.Atspi.Text.get_text(text, 0, -1)}.items():
                    try:
                        value = fn()
                        record[key] = value if isinstance(value, (str, int, float, bool, type(None))) else repr(value)
                    except Exception as error:
                        record[key] = {'error': repr(error)}
            try:
                evidence['insertion'] = runtime.insert_focused_text(window, 'éΩ字')
            except Exception as error:
                evidence['insertion_error'] = repr(error)
            time.sleep(.5)
            evidence['after'] = trial.state()
            bench.write_json(args.out / 'results.json', evidence)
            print(evidence, flush=True)
        finally:
            trial.close()


if __name__ == '__main__':
    main()
