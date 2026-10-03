import os, sys, errno
targets = [os.path.expanduser('~/Documents'), '/tmp']
print('pid', os.getpid(), 'ppid', os.getppid())
for t in targets:
    acc = os.access(t, os.R_OK | os.X_OK)
    try:
        n = sum(1 for _ in os.scandir(t))
        sc = f'ok {n}'
    except OSError as e:
        sc = f'err {e.errno} {errno.errorcode.get(e.errno)} {e.strerror}'
    try:
        os.stat(t); st = 'ok'
    except OSError as e:
        st = f'err {e.errno}'
    print(f'{t}: access(R|X)={acc} stat={st} scandir={sc}')
